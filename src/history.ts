// Blockchair Address Transactions — an address's latest (or earliest) transactions, each drawn with
// the addresses it spent from and paid to.
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import { CHAINS } from './address';
import type { Network } from './address';
import { Blockchair, ItemFailed, StopRun, TIME_UP, abortErr, asMap, requireKey } from './client';
import type { Answer } from './client';
import { ADDRESS, DRAW_SCOPES, KEY_CONFIG, LIFECYCLE, NETWORK, PLATFORMS, crypto, intParam, requireNet, selectedOfType, str, stopped, typePackHint } from './common';
import { addressFields, asOf } from './fields';
import { Addresses, Links } from './graph';
import { TX_BATCH, lookupTransactions } from './lookup';
import { addressTargets } from './targets';
import type { AddressTarget } from './targets';
import { drawTransaction, planTransaction } from './txgraph';
import { delta, points } from './values';

/** Blockchair's largest `offset` on the address dashboard (API docs). */
const MAX_OFFSET = 1_000_000;

/**
 * The entry for `query` in an address dashboard answer. Keyed by the address as asked, but taken
 * from the only entry when the key is spelled otherwise (a case or prefix difference), since a
 * single-address dashboard has exactly one.
 */
function entryFor(ans: Answer, query: string): any {
    const data = asMap(ans.data);
    if (data[query]) return data[query];
    const lower = Object.entries(data).find(([k]) => k.toLowerCase() === query.toLowerCase());
    if (lower) return lower[1];
    const vals = Object.values(data);
    return vals.length === 1 ? vals[0] : null;
}

const HASH = /^[0-9a-f]{64}$/;

/** Transaction hashes from the dashboard's `transactions`: objects with `transaction_details`,
 *  bare hashes without. */
function hashesOf(entry: any): string[] {
    const out: string[] = [];
    for (const t of Array.isArray(entry?.transactions) ? entry.transactions : []) {
        const h = (typeof t === 'string' ? t : str(t?.hash)).toLowerCase();
        if (HASH.test(h)) out.push(h);
    }
    return out;
}

export const history = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.blockchair_address_transactions',
        content_type: 'vineyard:plugin',
        name: 'Blockchair Address Transactions',
        version: '1.0.0',
        description:
            "Reads the latest (or, with Start from oldest, the earliest) confirmed transactions of each selected Crypto Address on Bitcoin, Bitcoin Cash, Litecoin, Bitcoin SV, Dogecoin, Dash or Zcash from Blockchair. Each becomes a Crypto Transaction (block_height, block_time, fee, tx_kind) linked 'input to' from every address it spends from and 'output to' every address it pays, each link with the amount and the inputs or outputs behind it. The address also gets tx_count, history_examined and history_complete, and the fields Blockchair Address Summary writes. Per transaction, the largest max_counterparties addresses on each side are drawn and the rest counted in blockchair_not_drawn. Needs a Blockchair API key.",
        icon: 'history',
        platforms: PLATFORMS,
        params: {
            type: 'object',
            properties: {
                max_transactions: {
                    type: 'integer',
                    title: 'Transactions per address',
                    default: 25,
                    minimum: 1,
                    maximum: 100,
                    description: 'How many transactions to read for each address. Default 25.',
                },
                start: {
                    type: 'string',
                    title: 'Start from',
                    enum: ['newest', 'oldest'],
                    default: 'newest',
                    description: "Newest reads the latest transactions; oldest the first ones, where an address's first funding is.",
                },
                max_counterparties: {
                    type: 'integer',
                    title: 'Counterparties per side',
                    default: 25,
                    minimum: 1,
                    maximum: 200,
                    description: 'Addresses drawn on each side of one transaction, largest amounts first. The selected addresses are always drawn. Default 25.',
                },
            },
        },
        io: { consumes: [crypto('crypto_address')], produces: [crypto('crypto_transaction'), crypto('crypto_address')] },
        scopes: { graph: DRAW_SCOPES, network: NETWORK, config: [KEY_CONFIG] },
        lifecycle: LIFECYCLE,
    },

    async run(ctx: HostContext): Promise<RunResult> {
        requireNet(ctx);
        const { nodes, other } = await selectedOfType(ctx, ADDRESS);
        const { targets, skipped } = addressTargets(nodes, other);
        if (!targets.length) {
            const why = skipped.length ? `: ${skipped.join('; ')}` : '';
            return { summary: `Select Crypto Address nodes on a network Blockchair covers first${why}.`, counts: { checked: 0, transactions: 0 } };
        }
        const client = new Blockchair(ctx, requireKey(ctx));
        const perAddress = intParam(ctx, 'max_transactions', 25, 1, 100);
        const cap = intParam(ctx, 'max_counterparties', 25, 1, 200);
        const oldest = ctx.params?.start === 'oldest';

        const addresses = new Addresses(ctx);
        for (const t of targets) {
            addresses.register(t.network, t.canonical, t.node.id);
            addresses.register(t.network, t.query, t.node.id);
        }
        const links = new Links(ctx);
        /**
         * What each address's entry said, written at the end. NOT written as it is read: the history
         * fields say what the graph holds, and until its transactions are drawn the graph holds none
         * of it. Written up front, a stop at the next address (or at the transaction batch) left
         * `history_complete: true` on an address whose transactions were never drawn — and the
         * STOPPED line told the analyst to re-run only the addresses not reached.
         */
        const reads: { t: AddressTarget; fields: Record<string, unknown>; hashes: string[]; count: number | undefined }[] = [];
        let wrote = false;
        let read = 0;
        let partial = 0;
        let unreachable = 0;
        let failed = 0;
        let refused = 0;
        let refusal = '';
        /** What ended the run early: a StopRun from Blockchair, or the time budget. */
        let halt: StopRun | undefined;
        let notReached = 0;
        const total = targets.length;

        // ---- transactions: queued per network, ten per request, drawn as they come -------------
        // Sent while the addresses are still being read, not after all of them. A long run is cut by
        // the time budget (client.ts), and reading every address first spent the run's points on
        // transaction lists that the cut then left undrawn; this way the addresses reached are the
        // ones drawn, and the rest were never asked about. The queue is shared by the addresses of a
        // network, so ten hashes still make one request; only the last few wait for the end.
        const pending = new Map<Network, string[]>();
        const queued = new Set<string>();
        const drawnTx = new Set<string>();
        let notDrawn = 0;
        let txFailed = 0;
        let typeProblem = '';
        const halted = () => halt !== undefined || typeProblem !== '';

        const drawBatch = async (network: Network, hashes: string[]): Promise<void> => {
            const res = await lookupTransactions(client, network, hashes);
            // Hashes the stop cut off are "not reached", not failures: their addresses are named by
            // the line that tells the analyst to run them again.
            const cut = (why: string) => why === 'not reached' || (res.stop !== undefined && why === res.stop.message);
            const cutOff = [...res.failed.values()].filter(cut).length;
            txFailed += res.failed.size - cutOff + res.missing.size;
            for (const [h, why] of res.failed) if (!cut(why)) ctx.progress?.log?.(`${h}: ${why}`);
            for (const [h, entry] of res.found) {
                if (client.pastDeadline()) {
                    halt ??= new StopRun(TIME_UP);
                    break;
                }
                const plan = planTransaction(network, entry);
                if (!plan || drawnTx.has(`${network}:${plan.hash}`)) continue;
                try {
                    const r = await drawTransaction(ctx, network, plan, addresses, links, cap);
                    notDrawn += r.notDrawn;
                    drawnTx.add(`${network}:${plan.hash}`);
                    wrote = true;
                } catch (e) {
                    typeProblem = typePackHint(e);
                    ctx.progress?.log?.(`${h}: ${typeProblem}`);
                    return;
                }
            }
            if (res.stop) halt ??= res.stop;
        };
        /** Sends `network`'s queue one request at a time: whole batches only, or all of it with `rest`. */
        const flush = async (network: Network, rest: boolean): Promise<void> => {
            const q = pending.get(network) ?? [];
            while (!halted() && (q.length >= TX_BATCH || (rest && q.length))) await drawBatch(network, q.splice(0, TX_BATCH));
        };

        // Past the soft budget no new address is read; the ones read are still drawn below, the
        // hard budget (client.ts) guarding those last requests.
        let outOfTime = false;
        for (let i = 0; i < total && !halted(); i++) {
            if (ctx.signal?.aborted) throw abortErr();
            if (client.outOfTime()) {
                outOfTime = true;
                notReached = total - i;
                break;
            }
            const t: AddressTarget = targets[i];
            const slug = CHAINS[t.network].slug;
            ctx.progress?.set?.({ percent: Math.round((i / total) * 100), message: `Blockchair: ${t.canonical}` });
            try {
                let offset = 0;
                if (oldest) {
                    // The count first (cost 1), to know where the oldest page starts.
                    const head = entryFor(await client.get(`${slug}/dashboards/address/${encodeURIComponent(t.query)}`, { limit: '0', state: 'latest' }), t.query);
                    if (!head?.address) throw new ItemFailed('Blockchair returned no address entry');
                    const count = Number(head.address.transaction_count) || 0;
                    offset = Math.max(0, count - perAddress);
                    if (offset > MAX_OFFSET) {
                        offset = MAX_OFFSET;
                        unreachable++;
                    }
                }
                const ans = await client.get(`${slug}/dashboards/address/${encodeURIComponent(t.query)}`, {
                    transaction_details: 'true',
                    limit: `${perAddress},0`,
                    offset: `${offset},0`,
                    state: 'latest',
                });
                const entry = entryFor(ans, t.query);
                if (!entry?.address) throw new ItemFailed('Blockchair returned no address entry');
                const hashes = hashesOf(entry).slice(0, perAddress);
                const count = Number.isSafeInteger(entry.address.transaction_count) ? entry.address.transaction_count : undefined;
                reads.push({ t, fields: addressFields(entry.address, t.kind, asOf(ans.context)), hashes, count });
                read++;
                const q = pending.get(t.network) ?? [];
                for (const h of hashes) {
                    if (queued.has(`${t.network}:${h}`)) continue;
                    queued.add(`${t.network}:${h}`);
                    q.push(h);
                }
                pending.set(t.network, q);
            } catch (e) {
                if (e instanceof StopRun) {
                    halt = e;
                    notReached = total - i;
                    break;
                }
                if (e instanceof ItemFailed) {
                    failed++;
                    ctx.progress?.log?.(`${t.node.id}: ${e.message}`);
                    continue;
                }
                throw e;
            }
            await flush(t.network, false);
            if (halted()) notReached = total - i - 1;
        }
        // The last few hashes of each network, fewer than a request's worth.
        for (const network of pending.keys()) await flush(network, true);
        if (outOfTime) halt ??= new StopRun(TIME_UP);
        // Once an address was read the run returns: what its entry said is still written below.
        const stop = halt ? stopped(halt, wrote || read > 0, notReached, 'address(es)') : '';

        // ---- the addresses ----------------------------------------------------------------------
        // `history_examined` and `history_complete` only when every transaction read for the address
        // is on the graph now (drawn by this run, for it or for another selected address). Otherwise
        // they are left as they were: a count of transactions that are not there, or a "complete"
        // over a history that is not, would be the false claim. The summary fields are written
        // either way — they come from the address entry, which was read in full.
        let undrawn = 0;
        for (const r of reads) {
            if (ctx.signal?.aborted) throw abortErr();
            const all = r.hashes.every((h) => drawnTx.has(`${r.t.network}:${h}`));
            const patch: Record<string, unknown> = { ...r.fields };
            if (all) {
                patch.history_examined = r.hashes.length;
                if (r.count !== undefined) {
                    patch.history_complete = r.hashes.length >= r.count;
                    if (r.hashes.length < r.count) partial++;
                }
            } else undrawn++;
            const d = delta(r.t.node.data, patch);
            if (!Object.keys(d).length) continue;
            try {
                await ctx.graph!.updateNode!(r.t.node.id, d);
                wrote = true;
            } catch (e) {
                // The project refused the write: this node's problem, and its transactions are drawn.
                refused++;
                refusal ||= typePackHint(e);
            }
        }
        ctx.progress?.set?.({ percent: 100 });

        const parts = [`${read} of ${total} address(es) read on Blockchair, ${drawnTx.size} transaction(s) drawn`];
        if (addresses.counterparties) parts.push(`${addresses.counterparties} counterparty address(es)`);
        const linked = links.describe();
        if (linked) parts.push(linked);
        if (undrawn) parts.push(`${undrawn} address(es) were read but not all of their transactions were drawn, so history_examined and history_complete were left as they were — run them again`);
        if (partial) parts.push(`${partial} address(es) have more transactions than were read (history_complete false) — raise Transactions per address, or start from ${oldest ? 'newest' : 'oldest'}`);
        if (unreachable) parts.push(`${unreachable} address(es) have over ${MAX_OFFSET.toLocaleString('en-US')} transactions, past Blockchair's paging limit: the oldest ones cannot be reached`);
        if (notDrawn) parts.push(`${notDrawn} counterparty address(es) past Counterparties per side were not drawn (blockchair_not_drawn on each transaction)`);
        if (failed) parts.push(`${failed} address lookup(s) failed`);
        if (refused) parts.push(`${refused} address update(s) refused by the project (${refusal})`);
        if (txFailed) parts.push(`${txFailed} transaction(s) could not be read`);
        if (typeProblem) parts.push(`STOPPED drawing: ${typeProblem}${notReached ? `. ${notReached} address(es) were not read` : ''}`);
        parts.push(...skipped);
        parts.push(`${points(client.cost)} Blockchair request point(s) used`);
        if (stop) parts.push(stop);
        return {
            summary: client.say(parts.join('. ') + '.'),
            counts: { checked: total, read, transactions: drawnTx.size, counterparties: addresses.counterparties, not_drawn: notDrawn, failed: failed + txFailed },
        };
    },
});

// Blockchair Transaction — a selected transaction's block, fee, inputs and outputs, drawn as links
// to the addresses on each side.
import { definePlugin } from './sdk';
import type { GraphNode, HostContext, RunResult } from './sdk';
import { CHAINS } from './address';
import type { Network } from './address';
import { Blockchair, StopRun, TIME_UP, abortErr, requireKey } from './client';
import { DRAW_SCOPES, KEY_CONFIG, LIFECYCLE, NETWORK, PLATFORMS, TRANSACTION, chunks, crypto, intParam, networkOf, requireNet, selectedOfType, skippedLines, str, stopped, typePackHint } from './common';
import { Addresses, Links } from './graph';
import { TX_BATCH, lookupTransactions } from './lookup';
import { byNetwork } from './targets';
import { drawTransaction, notDrawnPatch, planTransaction } from './txgraph';
import { delta, points } from './values';

interface TxTarget {
    node: GraphNode;
    network: Network;
    hash: string;
}

/** The type pack folds a 64-hex hash with or without 0x and in either case; Blockchair wants it
 *  bare and in lower case. */
const bareHash = (v: unknown): string | null => {
    const m = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(str(v));
    return m ? m[1].toLowerCase() : null;
};

/** Fields the selected node is identified by: never rewritten, so a node keeps its own spelling. */
const IDENTITY = new Set(['network', 'tx_hash']);

export const transaction = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.blockchair_transaction',
        content_type: 'vineyard:plugin',
        name: 'Blockchair Transaction',
        version: '1.0.0',
        description:
            "Looks up each selected Crypto Transaction on Bitcoin, Bitcoin Cash, Litecoin, Bitcoin SV, Dogecoin, Dash or Zcash in Blockchair, ten per request. Writes block_height, block_time, status, fee and tx_kind, with blockchair_input_count, blockchair_output_count and the totals, and links every address it spends from ('input to') and pays ('output to'), each link with the amount and the inputs or outputs behind it. The largest max_counterparties addresses on each side are drawn and the rest counted in blockchair_not_drawn. A transaction Blockchair does not have on the node's network is reported, not changed. Needs a Blockchair API key.",
        icon: 'arrow-left-right',
        platforms: PLATFORMS,
        params: {
            type: 'object',
            properties: {
                max_counterparties: {
                    type: 'integer',
                    title: 'Counterparties per side',
                    default: 50,
                    minimum: 1,
                    maximum: 200,
                    description: 'Addresses drawn on each side of the transaction, largest amounts first. Default 50.',
                },
            },
        },
        io: { consumes: [crypto('crypto_transaction')], produces: [crypto('crypto_address')] },
        scopes: { graph: DRAW_SCOPES, network: NETWORK, config: [KEY_CONFIG] },
        lifecycle: LIFECYCLE,
    },

    async run(ctx: HostContext): Promise<RunResult> {
        requireNet(ctx);
        const { nodes, other } = await selectedOfType(ctx, TRANSACTION);
        const targets: TxTarget[] = [];
        let unestablished = 0;
        let invalid = 0;
        const others = new Map<string, number>();
        for (const node of nodes) {
            const net = networkOf(node);
            if (!net.network) {
                if (net.skip === 'unestablished') unestablished++;
                else others.set(net.name, (others.get(net.name) ?? 0) + 1);
                continue;
            }
            const hash = bareHash(node.data?.tx_hash);
            if (!hash) {
                invalid++;
                continue;
            }
            targets.push({ node, network: net.network, hash });
        }
        const skipped = skippedLines(unestablished, others, other, 'transaction');
        if (invalid) skipped.push(`${invalid} transaction(s) have no 64-hex tx_hash`);
        if (!targets.length) {
            const why = skipped.length ? `: ${skipped.join('; ')}` : '';
            return { summary: `Select Crypto Transaction nodes on a network Blockchair covers first${why}.`, counts: { checked: 0, found: 0 } };
        }
        const client = new Blockchair(ctx, requireKey(ctx));
        const cap = intParam(ctx, 'max_counterparties', 50, 1, 200);
        const addresses = new Addresses(ctx);
        const links = new Links(ctx);
        let found = 0;
        let missing = 0;
        let failed = 0;
        let notDrawn = 0;
        let wrote = false;
        let stop = '';
        let typeProblem = '';
        const notFound: string[] = [];
        let done = 0;

        // One request's worth at a time, looked up and then drawn, so the time budget (client.ts)
        // cuts between batches and never leaves answers read but not drawn. The STOPPED count is
        // what this batch did not reach plus every later batch, on every network: counted from the
        // stopped network alone, it left the rest of the selection out.
        const batches = [...byNetwork(targets)].flatMap(([network, list]) => chunks(list, TX_BATCH).map((part) => ({ network, part })));
        for (let b = 0; b < batches.length; b++) {
            if (ctx.signal?.aborted) throw abortErr();
            const { network, part } = batches[b];
            if (client.outOfTime()) {
                stop = stopped(new StopRun(TIME_UP), wrote, batches.slice(b).reduce((a, x) => a + x.part.length, 0), 'transaction(s)');
                break;
            }
            ctx.progress?.set?.({ percent: Math.round((done / targets.length) * 100), message: `Blockchair: ${CHAINS[network].label} transactions` });
            const res = await lookupTransactions(client, network, part.map((t) => t.hash));
            done += part.length;
            const cut = (why: string) => why === 'not reached' || (res.stop !== undefined && why === res.stop.message);
            let late: StopRun | undefined;
            let left = 0;
            for (const t of part) {
                const entry = res.found.get(t.hash);
                if (!entry) {
                    if (res.missing.has(t.hash)) {
                        missing++;
                        if (notFound.length < 5) notFound.push(`${t.hash.slice(0, 12)}… on ${CHAINS[network].label}`);
                    } else if (cut(res.failed.get(t.hash) ?? '')) {
                        left++;
                    } else {
                        failed++;
                        ctx.progress?.log?.(`${t.node.id}: ${res.failed.get(t.hash) ?? 'no answer'}`);
                    }
                    continue;
                }
                // Read, but the hard budget has passed: not drawn, and counted with what was not reached.
                if (late || client.pastDeadline()) {
                    late ??= new StopRun(TIME_UP);
                    left++;
                    continue;
                }
                const plan = planTransaction(network, entry);
                if (!plan) {
                    failed++;
                    continue;
                }
                found++;
                try {
                    const r = await drawTransaction(ctx, network, plan, addresses, links, cap, t.node.id);
                    notDrawn += r.notDrawn;
                    const patch: Record<string, unknown> = { ...notDrawnPatch(t.node.data?.blockchair_not_drawn, r.notDrawn) };
                    for (const [k, v] of Object.entries(plan.fields)) if (!IDENTITY.has(k)) patch[k] = v;
                    const d = delta(t.node.data, patch);
                    if (Object.keys(d).length) await ctx.graph!.updateNode!(t.node.id, d);
                    wrote = true;
                } catch (e) {
                    typeProblem = typePackHint(e);
                    break;
                }
            }
            if (typeProblem) break;
            const halt = res.stop ?? late;
            if (halt) {
                left += batches.slice(b + 1).reduce((a, x) => a + x.part.length, 0);
                stop = stopped(halt, wrote, left, 'transaction(s)');
                break;
            }
        }
        ctx.progress?.set?.({ percent: 100 });

        const parts = [`${found} of ${targets.length} transaction(s) found on Blockchair`];
        if (addresses.counterparties) parts.push(`${addresses.counterparties} address(es) on their inputs and outputs`);
        const linked = links.describe();
        if (linked) parts.push(linked);
        if (missing) parts.push(`${missing} not on the node's network per Blockchair (${notFound.join(', ')}${missing > notFound.length ? ', …' : ''}) — a real negative: check the network`);
        if (notDrawn) parts.push(`${notDrawn} counterparty address(es) past Counterparties per side were not drawn (blockchair_not_drawn)`);
        if (failed) parts.push(`${failed} lookup(s) failed`);
        if (typeProblem) parts.push(`STOPPED drawing: ${typeProblem}`);
        parts.push(...skipped);
        parts.push(`${points(client.cost)} Blockchair request point(s) used`);
        if (stop) parts.push(stop);
        return {
            summary: client.say(parts.join('. ') + '.'),
            counts: { checked: targets.length, found, not_found: missing, counterparties: addresses.counterparties, not_drawn: notDrawn, failed },
        };
    },
});

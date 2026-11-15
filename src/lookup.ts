// The two batched reads every plugin builds on: up to 100 addresses, and up to 10 transactions,
// per request.
import { CHAINS, canonicalAddress, queryForm } from './address';
import type { Network } from './address';
import { ItemFailed, StopRun, TIME_UP, asMap } from './client';
import type { Answer, Blockchair } from './client';
import { chunks } from './common';

/**
 * Addresses per `dashboards/addresses` request. 100 is Blockchair's maximum; a URL of 100 P2SH32
 * CashAddrs is about 6,300 characters, which every server in front of the API accepts.
 * The cost is 1 + 0.1 per further address (10.9 for 100), against 1 each one at a time.
 */
export const ADDRESS_BATCH = 100;
/** Transactions per `dashboards/transactions` request: Blockchair's maximum, cost 1.9 for 10. */
export const TX_BATCH = 10;

/**
 * Halvings one lookup may spend finding the items of a batch Blockchair refuses with 400.
 *
 * One address Blockchair will not take fails its whole request: before this, the 99 valid addresses
 * sharing it were logged as failed lookups, and in Network Check every unknown address probed on
 * that network came out "no answer". The validator accepts formats newer than the documentation the
 * pack was built from (a P2SH32 CashAddr, a SegWit v2–16 or Litecoin taproot address), and whether
 * Blockchair refuses them is not known without a key. So a refused batch is split in half and each
 * half asked again, down to the single item: about seven halvings find one bad address among 100.
 * The cap keeps a 400 that every request gets — a changed API, say — from turning a 100-address
 * batch into 199 requests; past it a refused batch fails as a whole, as before.
 */
export const MAX_SPLITS = 16;

/** Puts the two halves of a refused `batch` at the front of `work` when a split is due. */
function splitOn400<T>(e: ItemFailed, batch: T[], work: T[][], budget: { left: number }): boolean {
    if (e.status !== 400 || batch.length < 2 || budget.left <= 0) return false;
    budget.left--;
    const half = Math.ceil(batch.length / 2);
    work.unshift(batch.slice(0, half), batch.slice(half));
    return true;
}

export interface AddressBatch {
    /** The answer's entry for each query form that Blockchair listed. */
    found: Map<string, any>;
    /** Query forms that were asked and not listed: never used on this network. */
    unused: Set<string>;
    /** Query forms whose request failed, with why. */
    failed: Map<string, string>;
    context: any;
    /** Set when a condition ended the run part-way: what was found before it is still returned. */
    stop?: StopRun;
}

/**
 * An entry listed with nothing ever received. The docs say the multi-address dashboard leaves unused
 * addresses out, which is not yet checked against the live API (live-test.mjs asks); if it lists them
 * with zeros instead, they must still be unused — counted as found, Network Check would settle an
 * address "by activity" on every network it is merely valid on.
 */
const neverUsed = (e: any): boolean => Number(e?.output_count) === 0 && !e?.first_seen_receiving && !e?.last_seen_receiving;

/**
 * The multi-address dashboard for `forms` on one network, `limit=0` (no transaction lists) and
 * `state=latest` (confirmed only). One failed request fails its own batch (a 400 is split first, see
 * MAX_SPLITS); a StopRun ends the lookup and is returned in `stop`, with the batches already
 * answered. Past the soft time budget no new batch is sent: the rest are 'not reached'.
 *
 * Blockchair keys `data.addresses` by the address as given. The lookup also tries the lower-case
 * key, because bech32 and CashAddr are case-insensitive and nothing in the docs promises which case
 * comes back.
 */
export async function lookupAddresses(client: Blockchair, network: Network, forms: string[]): Promise<AddressBatch> {
    const out: AddressBatch = { found: new Map(), unused: new Set(), failed: new Map(), context: {} };
    const work = chunks([...new Set(forms)], ADDRESS_BATCH);
    const splits = { left: MAX_SPLITS };
    while (work.length) {
        const batch = work.shift()!;
        if (!out.stop && client.outOfTime()) out.stop = new StopRun(TIME_UP);
        if (out.stop) {
            for (const f of batch) out.failed.set(f, 'not reached');
            continue;
        }
        let ans: Answer;
        try {
            ans = await client.get(`${CHAINS[network].slug}/dashboards/addresses/${batch.map(encodeURIComponent).join(',')}`, { limit: '0', state: 'latest' });
        } catch (e) {
            if (e instanceof StopRun) out.stop = e;
            else if (!(e instanceof ItemFailed)) throw e;
            else if (splitOn400(e, batch, work, splits)) continue;
            for (const f of batch) out.failed.set(f, e.message);
            continue;
        }
        // Only an answer that carries the `addresses` list can say an address is missing from it. A
        // `data` that is null, or has no such key, is a failed request — read as "nothing listed",
        // it would mark every address of the batch never used.
        const list = ans.data && typeof ans.data === 'object' && !Array.isArray(ans.data) ? ans.data.addresses : undefined;
        if (!list || typeof list !== 'object') {
            for (const f of batch) out.failed.set(f, 'Blockchair answered without an addresses list');
            continue;
        }
        out.context = ans.context;
        const listed = asMap(list);
        const byLower = new Map<string, any>();
        for (const [k, v] of Object.entries(listed)) {
            byLower.set(k, v);
            byLower.set(k.toLowerCase(), v);
            // A key in another spelling of the same address (a prefixed CashAddr, say) still matches.
            const c = canonicalAddress(network, k);
            if (c) byLower.set(queryForm(network, c.address), v);
        }
        for (const f of batch) {
            const hit = byLower.get(f) ?? byLower.get(f.toLowerCase());
            if (hit && typeof hit === 'object' && !neverUsed(hit)) out.found.set(f, hit);
            else out.unused.add(f);
        }
    }
    return out;
}

export interface TxBatch {
    found: Map<string, any>;
    missing: Set<string>;
    failed: Map<string, string>;
    stop?: StopRun;
}

/**
 * The transaction dashboards for `hashes` (lower-case 64-hex) on one network, ten per request.
 * Failures, a 400 and a StopRun are handled as in lookupAddresses. The soft time budget is the
 * caller's to check, between its batches: both callers send one request's worth at a time, and
 * Address Transactions finishes an address it has read rather than leave it half drawn.
 */
export async function lookupTransactions(client: Blockchair, network: Network, hashes: string[], onBatch?: (done: number) => void): Promise<TxBatch> {
    const out: TxBatch = { found: new Map(), missing: new Set(), failed: new Map() };
    let done = 0;
    const work = chunks([...new Set(hashes)], TX_BATCH);
    const splits = { left: MAX_SPLITS };
    while (work.length) {
        const batch = work.shift()!;
        if (out.stop) {
            for (const h of batch) out.failed.set(h, 'not reached');
            continue;
        }
        let ans: Answer;
        try {
            ans = await client.get(`${CHAINS[network].slug}/dashboards/transactions/${batch.join(',')}`);
        } catch (e) {
            if (e instanceof StopRun) out.stop = e;
            else if (!(e instanceof ItemFailed)) throw e;
            else if (splitOn400(e, batch, work, splits)) continue;
            for (const h of batch) out.failed.set(h, e.message);
            done += batch.length;
            onBatch?.(done);
            continue;
        }
        // A transaction can be "not on this network" only by an answer that has a `data` to be
        // missing from: an object keyed by hash, or the `[]` PHP writes for an empty one. `null` —
        // what a 404 that passed client.get carries — fails the batch instead.
        if (!ans.data || typeof ans.data !== 'object') {
            for (const h of batch) out.failed.set(h, 'Blockchair answered without transaction data');
            done += batch.length;
            onBatch?.(done);
            continue;
        }
        const data = asMap(ans.data);
        const byLower = new Map(Object.entries(data).map(([k, v]) => [k.toLowerCase(), v]));
        for (const h of batch) {
            const hit = byLower.get(h);
            if (hit && typeof hit === 'object' && hit.transaction) out.found.set(h, hit);
            else out.missing.add(h);
        }
        done += batch.length;
        onBatch?.(done);
    }
    return out;
}

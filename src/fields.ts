// Blockchair's address object → fields on a cryptocurrency.crypto_address node. Pure.
import type { AddressKind } from './address';
import { compact, earliest, isoTime, latest, toDecimal } from './values';

export const SOURCE = 'Blockchair';

/**
 * When Blockchair computed an answer: `context.cache.since` (its answers are cached, by default for
 * about a minute), else the time it arrived. It is the honest `balance_as_of` — the balance is the
 * one Blockchair held then, not the one at the moment the run finished.
 */
export function asOf(context: any, now: () => Date = () => new Date()): string {
    return isoTime(context?.cache?.since) ?? now().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The fields one address dashboard entry gives.
 *
 * Declared fields carry the facts any source would agree on — first and last use, balance, kind —
 * and `blockchair_*` the split Blockchair alone gives: when the address first and last RECEIVED and
 * SPENT, and the totals each way. `first_seen` is the earlier of the first receipt and first spend
 * (an address must receive before it can spend, so in practice the first receipt).
 *
 * `tx_count` only when Blockchair counted it: the single-address dashboard does, the 100-address one
 * does not (`transaction_count` is "available only in the address endpoint", API docs).
 *
 * Amounts are confirmed only: every call is made with `state=latest`, which leaves mempool
 * transactions out of the balance, the totals and the dates.
 */
export function addressFields(obj: any, kind: AddressKind, when: string): Record<string, unknown> {
    const fr = isoTime(obj?.first_seen_receiving);
    const lr = isoTime(obj?.last_seen_receiving);
    const fs = isoTime(obj?.first_seen_spending);
    const ls = isoTime(obj?.last_seen_spending);
    const count = obj?.transaction_count;
    return compact({
        address_kind: kind,
        first_seen: earliest(fr, fs),
        last_seen: latest(lr, ls),
        tx_count: Number.isSafeInteger(count) && count >= 0 ? count : undefined,
        balance: toDecimal(obj?.balance),
        balance_as_of: when,
        balance_source: SOURCE,
        blockchair_received: toDecimal(obj?.received),
        blockchair_spent: toDecimal(obj?.spent),
        blockchair_first_received: fr,
        blockchair_last_received: lr,
        blockchair_first_spent: fs,
        blockchair_last_spent: ls,
        blockchair_output_count: Number.isSafeInteger(obj?.output_count) ? obj.output_count : undefined,
    });
}

/**
 * An address Blockchair has never seen in a transaction. Its multi-address dashboard leaves such
 * addresses out of `data.addresses` (API docs); after a canonical-form query that is a real
 * negative — no transaction on this network — and the balance is zero.
 *
 * Said as `blockchair_output_count: 0` (nothing ever received, so nothing ever spent), NOT as
 * `tx_count: 0`. The multi-address dashboard never gives a transaction count, so a `tx_count: 0`
 * written here would outlive the address's first use: the next summary would update the balance
 * and leave the zero count standing. The output count is in every answer and is rewritten by it.
 */
export function unusedFields(kind: AddressKind, when: string): Record<string, unknown> {
    return {
        address_kind: kind,
        balance: '0',
        balance_as_of: when,
        balance_source: SOURCE,
        blockchair_received: '0',
        blockchair_output_count: 0,
    };
}

// A Blockchair transaction dashboard entry → a transaction node, `input to` links from the
// addresses it spends from and `output to` links to the addresses it pays.
//
// The model is the Cryptocurrency type pack's for UTXO chains: a transaction is a node, and a pair
// has one edge, so an address that appears in several inputs (or outputs) of one transaction gets
// one link carrying the total and the list. `planTransaction` is pure; `drawTransaction` writes.
import type { HostContext } from './sdk';
import { canonicalAddress } from './address';
import type { AddressKind, Network } from './address';
import { TRANSACTION, str } from './common';
import type { Addresses, Links } from './graph';
import { compact, isoTime, toBig, toDecimal } from './values';

export interface InputEntry {
    index?: number;
    amount?: string;
    prev_txid?: string;
    prev_vout?: number;
}
export interface OutputEntry {
    index?: number;
    amount?: string;
}

export interface Side<E> {
    address: string;
    kind: AddressKind;
    total: bigint;
    entries: E[];
}

export interface TxPlan {
    hash: string;
    fields: Record<string, unknown>;
    inputs: Side<InputEntry>[];
    outputs: Side<OutputEntry>[];
    /** Inputs and outputs with no address on this network: OP_RETURN data, bare multisig and other
     *  non-standard scripts, which Blockchair lists under synthetic names of its own. */
    unaddressed: number;
}

const HASH = /^[0-9a-f]{64}$/;

const int = (v: unknown): number | undefined => (Number.isSafeInteger(v) ? (v as number) : undefined);

function group<E>(network: Network, rows: any[], entry: (r: any) => E): { sides: Side<E>[]; unaddressed: number } {
    const by = new Map<string, Side<E>>();
    let unaddressed = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
        const c = canonicalAddress(network, str(r?.recipient));
        if (!c) {
            unaddressed++;
            continue;
        }
        let s = by.get(c.address);
        if (!s) by.set(c.address, (s = { address: c.address, kind: c.kind, total: 0n, entries: [] }));
        s.total += toBig(r?.value) ?? 0n;
        s.entries.push(entry(r));
    }
    // Largest first: when a transaction has more counterparties than a run draws, the ones it keeps
    // are the ones most of the money went through. Address order breaks ties, so a re-run draws the
    // same set.
    const sides = [...by.values()].sort((a, b) => (a.total === b.total ? (a.address < b.address ? -1 : 1) : a.total > b.total ? -1 : 1));
    return { sides, unaddressed };
}

/**
 * The plan for one entry of `dashboards/transaction(s)`, or null when it is not a transaction this
 * pack can read (no 64-hex hash).
 *
 * Inputs are Blockchair's spent outputs: `spending_index` is the input's position in THIS
 * transaction, `transaction_hash` and `index` the output it spends — the type pack's `index`,
 * `prev_txid` and `prev_vout`.
 */
export function planTransaction(network: Network, entry: any): TxPlan | null {
    const tx = entry?.transaction;
    const hash = str(tx?.hash).toLowerCase();
    if (!HASH.test(hash)) return null;
    const block = int(tx?.block_id);
    const confirmed = block !== undefined && block >= 0;
    const coinbase = tx?.is_coinbase === true;
    const ins = group<InputEntry>(network, entry?.inputs, (r) =>
        compact({ index: int(r?.spending_index), amount: toDecimal(r?.value), prev_txid: str(r?.transaction_hash).toLowerCase() || undefined, prev_vout: int(r?.index) }),
    );
    const outs = group<OutputEntry>(network, entry?.outputs, (r) => compact({ index: int(r?.index), amount: toDecimal(r?.value) }));
    const unaddressed = ins.unaddressed + outs.unaddressed;
    const fields = compact({
        network,
        tx_hash: hash,
        block_height: confirmed ? block : undefined,
        block_time: confirmed ? isoTime(tx?.time) : undefined,
        status: confirmed ? 'success' : 'pending',
        // A coinbase pays no fee; Blockchair's figure for one is not a fee anyone paid.
        fee: coinbase ? undefined : toDecimal(tx?.fee),
        tx_kind: coinbase ? 'coinbase' : 'transfer',
        blockchair_input_count: int(tx?.input_count),
        blockchair_output_count: int(tx?.output_count),
        blockchair_input_total: toDecimal(tx?.input_total),
        blockchair_output_total: toDecimal(tx?.output_total),
        blockchair_unaddressed: unaddressed || undefined,
    });
    return { hash, fields, inputs: ins.sides, outputs: outs.sides, unaddressed };
}

/**
 * Which counterparties to draw on one side: every selected address, then the `cap` largest of the
 * rest. Returns the drawn sides and how many were left out.
 */
export function selectSides<E>(sides: Side<E>[], isSeed: (address: string) => boolean, cap: number): { drawn: Side<E>[]; left: number } {
    const drawn: Side<E>[] = [];
    let others = 0;
    let left = 0;
    for (const s of sides) {
        if (isSeed(s.address)) drawn.push(s);
        else if (others < cap) {
            drawn.push(s);
            others++;
        } else left++;
    }
    return { drawn, left };
}

/** Entries kept per link. A consolidation can spend hundreds of outputs of one address, and an
 *  edge's data is capped at 256 KiB by the server; the total in `amount` is always the full one. */
export const MAX_ENTRIES = 100;

function entryData<E>(side: Side<E>, listKey: 'inputs' | 'outputs'): Record<string, unknown> {
    const data: Record<string, unknown> = { amount: toDecimal(side.total) ?? '0', [listKey]: side.entries.slice(0, MAX_ENTRIES) };
    if (side.entries.length > MAX_ENTRIES) data[`${listKey}_omitted`] = side.entries.length - MAX_ENTRIES;
    return data;
}

export interface Drawn {
    txId: string;
    notDrawn: number;
}

/**
 * The `blockchair_not_drawn` to write onto a transaction that holds `existing`, as a patch: `{}` when
 * the value it has should stand.
 *
 * The count is how many counterparties the graph does not show, and this run's figure counts only
 * against this run's cap. The links an earlier run drew stay on the graph, so a later run with a
 * smaller cap — Address Transactions defaults to 25 per side, Blockchair Transaction to 50 — must not
 * raise the count: written over, a transaction drawn in full read "5 not drawn" with all 30 of its
 * outputs linked. A lower figure is written (a higher cap drew more), and so is any figure where the
 * node has none, 0 included, so a run that draws everything can say so.
 */
export function notDrawnPatch(existing: unknown, notDrawn: number): { blockchair_not_drawn?: number } {
    const have = Number.isSafeInteger(existing) && (existing as number) >= 0 ? (existing as number) : undefined;
    return have !== undefined && have <= notDrawn ? {} : { blockchair_not_drawn: notDrawn };
}

/**
 * Write one planned transaction.
 *
 * `txId` is the node to draw from when the transaction is a selected node, and the caller writes its
 * fields; otherwise the node is created (or found, by its network and hash) from the plan's fields,
 * and `blockchair_not_drawn` is written onto it by notDrawnPatch. Not in the createNode call: the
 * host fill-merges what createNode is given onto a node it finds, so the count would overwrite the
 * lower one the node already holds before this could look at it.
 */
export async function drawTransaction(
    ctx: HostContext,
    network: Network,
    plan: TxPlan,
    addresses: Addresses,
    links: Links,
    cap: number,
    txId?: string,
): Promise<Drawn> {
    const isSeed = (a: string) => addresses.isSelected(network, a);
    const ins = selectSides(plan.inputs, isSeed, cap);
    const outs = selectSides(plan.outputs, isSeed, cap);
    const notDrawn = ins.left + outs.left;
    let id = txId;
    if (!id) {
        const node = await ctx.graph!.createNode!({ type: TRANSACTION, data: plan.fields });
        id = String(node.id);
        const count = notDrawnPatch(node.data?.blockchair_not_drawn, notDrawn);
        if (count.blockchair_not_drawn !== undefined) await ctx.graph!.updateNode!(id, count);
    }
    for (const s of ins.drawn) {
        const from = await addresses.ensure(network, s.address);
        await links.link(from, id, 'input to', entryData(s, 'inputs'));
    }
    for (const s of outs.drawn) {
        const to = await addresses.ensure(network, s.address);
        await links.link(id, to, 'output to', entryData(s, 'outputs'));
    }
    return { txId: id, notDrawn };
}

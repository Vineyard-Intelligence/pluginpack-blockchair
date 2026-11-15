// Selected address nodes → what to ask Blockchair, and what to say about the rest.
import type { GraphNode } from './sdk';
import { canonicalAddress, queryForm } from './address';
import type { AddressKind, Network } from './address';
import { networkOf, skippedLines, str } from './common';

export interface AddressTarget {
    node: GraphNode;
    network: Network;
    /** The type pack's canonical form on `network`. */
    canonical: string;
    /** What is sent: the canonical form, except a token-aware CashAddr (see queryForm). */
    query: string;
    kind: AddressKind;
    /** The node's own spelling differs from the canonical one (a legacy BCH address, an LTC `3…`). */
    respelled: boolean;
}

export interface Targets {
    targets: AddressTarget[];
    /** Lines for the summary about the selected nodes that are not looked up. */
    skipped: string[];
    skippedCount: number;
}

export function addressTargets(nodes: GraphNode[], wrongType: number): Targets {
    const targets: AddressTarget[] = [];
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
        const raw = str(node.data?.address);
        const c = canonicalAddress(net.network, raw);
        if (!c) {
            invalid++;
            continue;
        }
        targets.push({ node, network: net.network, canonical: c.address, query: queryForm(net.network, c.address), kind: c.kind, respelled: c.address !== raw });
    }
    const skipped = skippedLines(unestablished, others, wrongType, 'address');
    if (invalid) skipped.push(`${invalid} address(es) are not a valid address on their network (format or checksum) and were not sent`);
    return { targets, skipped, skippedCount: unestablished + invalid + [...others.values()].reduce((a, b) => a + b, 0) };
}

/** Targets grouped by network, in the order networks first appear. */
export function byNetwork<T extends { network: Network }>(xs: T[]): Map<Network, T[]> {
    const m = new Map<Network, T[]>();
    for (const x of xs) {
        if (!m.has(x.network)) m.set(x.network, []);
        m.get(x.network)!.push(x);
    }
    return m;
}

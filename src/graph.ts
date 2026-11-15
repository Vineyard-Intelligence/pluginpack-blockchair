// Graph writes the drawing plugins share: links that follow the type pack's one-edge-per-pair rule,
// and address nodes in canonical form.
import type { GraphEdge, GraphNode, HostContext } from './sdk';
import { ADDRESS } from './common';
import type { Network } from './address';

const pairKey = (from: string, to: string) => `${from}\u0000${to}`;

/**
 * Links written the way the Cryptocurrency type pack asks: a pair of nodes has one edge, so a pair
 * that already has one keeps its label — whoever wrote it, the analyst included — and only gets this
 * pack's data keys. A write that would change nothing is not made, so a re-run over the same
 * transactions puts no rows in the review.
 *
 * WHAT "WOULD CHANGE NOTHING" CAN BE KNOWN FROM. The SDK's GraphEdge promises `data`, and the app's
 * host hands plugins a copy of it (host-bridge.ts toEdge, frontend main 2026-11-16), so an edge that
 * comes with `data` is compared key by key: one that holds what this run would write is left alone,
 * and one that holds other amounts, or none, is given this run's. Older versions of the app built
 * `edges()` without it (measured 2026-11-15: id, endpoints and label only), and on them a data-only
 * update whose data equals the live data was still staged as a review row. When an edge comes
 * without `data`, the data is unknown and `unknownSameLabel` decides:
 *   - 'skip' (the transaction drawers): an edge that already has the label this run would write is
 *     left alone and counted in `unread`. What this pack writes on `input to` / `output to` is a
 *     function of the transaction alone (the address's entries and their total), so an edge it drew
 *     before already holds it; restating it would put one identical row per link in the review —
 *     up to 25 transactions × 2 sides × 25 links per address. The cost, on such an app only: a
 *     same-label edge someone else drew WITHOUT amounts does not get them.
 *   - 'restate' (Network Check): the update is staged. Its few links carry `check_blockchair`
 *     (`basis`, `as_of`), which does change — a format-settled address that is later used becomes
 *     `activity`.
 * An edge under another label always gets the data: that is the type pack's rule, and the only way
 * the amounts reach a link the analyst drew.
 *
 * Existing edges are read once per run (`edge:read`). A pair this run already wrote is not written
 * twice.
 */
export class Links {
    private live: Map<string, GraphEdge> | null = null;
    private done = new Set<string>();
    created = 0;
    /** Existing edges given this pack's data (another label, or data known to differ). */
    amended = 0;
    /** Existing same-label edges left alone because their data could not be read ('skip'). */
    unread = 0;

    constructor(
        private ctx: HostContext,
        private unknownSameLabel: 'skip' | 'restate' = 'skip',
    ) {}

    private async index(): Promise<Map<string, GraphEdge>> {
        if (this.live) return this.live;
        const m = new Map<string, GraphEdge>();
        try {
            for (const e of (await this.ctx.graph?.edges?.()) ?? []) m.set(pairKey(String(e.from_node_id), String(e.to_node_id)), e);
        } catch {
            /* unreadable: every pair is treated as new, and the host turns a create on a linked pair into an update */
        }
        this.live = m;
        return m;
    }

    async link(from: string, to: string, label: string, data: Record<string, unknown>): Promise<void> {
        const key = pairKey(from, to);
        if (this.done.has(key)) return;
        this.done.add(key);
        const existing = (await this.index()).get(key);
        if (!existing) {
            await this.ctx.graph!.createEdge!({ from, to, label, data });
            this.created++;
            return;
        }
        const have = existing.data && typeof existing.data === 'object' ? existing.data : undefined;
        if (have) {
            const changed = Object.keys(data).some((k) => JSON.stringify(have[k]) !== JSON.stringify(data[k]));
            if (!changed) return;
        } else if (this.unknownSameLabel === 'skip' && String(existing.label ?? '').trim() === label.trim()) {
            this.unread++;
            return;
        }
        if (this.ctx.graph?.updateEdge) {
            await this.ctx.graph.updateEdge(String(existing.id), { data });
        } else {
            // An older host without updateEdge: restating the edge's OWN label with data is staged as
            // a data change that keeps the label.
            await this.ctx.graph!.createEdge!({ from, to, label: existing.label, data });
        }
        this.amended++;
    }

    /** The summary's words for what happened to links, or '' when none were touched. */
    describe(): string {
        const parts: string[] = [];
        if (this.created) parts.push(`${this.created} new link(s)`);
        if (this.amended) parts.push(`${this.amended} existing link(s) given amounts`);
        if (this.unread) parts.push(`${this.unread} link(s) already drawn with the same label left as they were: their data was not passed to this run (an older Vineyard does not pass a link's data to plugins), and a transaction's amounts do not change`);
        return parts.join(', ');
    }
}

/**
 * Address nodes for one run: the selected ones by their canonical form, the rest created with their
 * identity fields only.
 *
 * Only `network` and `address`, so an address that is already in the project is linked to and not
 * rewritten — createNode merges what it is given onto an existing node, and a kind or label this run
 * did not look up has no business replacing one someone else did. The summary plugin fills the
 * rest when it is run on the node.
 *
 * Selected nodes are registered first under their canonical form, because the identity rule folds
 * letter case and nothing more: a selected Bitcoin Cash node written in the legacy `1…` form would
 * not match the CashAddr a transaction lists, and createNode would make a second node for the same
 * account.
 */
export class Addresses {
    private byKey = new Map<string, string>();
    /**
     * The selected nodes alone, apart from `byKey`: a counterparty drawn for one transaction must not
     * count as selected in the next, or every address drawn earlier in a run would bypass the
     * Counterparties per side cap, and which addresses a transaction draws would depend on the order
     * its neighbours were processed in.
     */
    private seeds = new Set<string>();
    /** Addresses written this run besides the selected ones — new or already in the project. */
    counterparties = 0;

    constructor(private ctx: HostContext) {}

    register(network: Network, canonical: string, id: string): void {
        this.byKey.set(`${network}:${canonical}`, id);
        this.seeds.add(`${network}:${canonical}`);
    }

    /** Whether the address is one of the run's selected nodes (always drawn, outside the cap). */
    isSelected(network: Network, canonical: string): boolean {
        return this.seeds.has(`${network}:${canonical}`);
    }

    async ensure(network: Network, canonical: string): Promise<string> {
        const k = `${network}:${canonical}`;
        const hit = this.byKey.get(k);
        if (hit) return hit;
        const node: GraphNode = await this.ctx.graph!.createNode!({ type: ADDRESS, data: { network, address: canonical } });
        const id = String(node.id);
        this.counterparties++;
        this.byKey.set(k, id);
        return id;
    }
}

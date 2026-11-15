// Manifest fragments and selection handling every Blockchair plugin shares.
import type { ConfigValue, GraphNode, GraphScope, HostContext, NetworkScope, PluginManifest, TypeRef } from './sdk';
import { API, abortErr } from './client';
import type { StopRun } from './client';
import { isCovered } from './address';
import type { Network } from './address';

export const CRYPTO = 'run.vineyard.typepacks.cryptocurrency';
export const crypto = (name: string): TypeRef => ({ typepack: CRYPTO, category: 'cryptocurrency', name });
export const ADDRESS = 'cryptocurrency.crypto_address';
export const TRANSACTION = 'cryptocurrency.crypto_transaction';

// PLATFORM: web and desktop. Blockchair answers with `Access-Control-Allow-Origin: *`, its errors
// included (measured 2026-11-14 on a 402 and a 430), and the key rides in the query string, so a
// request is a plain GET with no preflight.
export const PLATFORMS: PluginManifest['platforms'] = {
    primary: 'web',
    web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
    desktop: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
};

// ONE NETWORK LIST FOR EVERY MEMBER. The app files a pack's settings by the set of origins a member
// calls (config-slot.ts), so the key is typed once only while every member names the same one.
export const NETWORK: NetworkScope[] = [
    {
        endpoint: `${API}/`,
        methods: ['GET'],
        purpose: 'Read address and transaction dashboards for Bitcoin, Bitcoin Cash, Litecoin, Bitcoin SV, Dogecoin, Dash and Zcash, with your API key.',
    },
];

export const KEY_CONFIG: ConfigValue = { key: 'api_key', label: 'Blockchair API key', type: 'string', secret: true, optional: false };

/** Read and update only: the summary writes onto the selected nodes and creates nothing. */
export const UPDATE_SCOPES: GraphScope[] = ['node:read', 'node:update'];
/**
 * Plugins that draw transactions. `edge:read` is the type pack's edge rule: a pair of nodes has one
 * edge, so an existing one is read and has data keys added, never its label changed.
 */
export const DRAW_SCOPES: GraphScope[] = ['node:read', 'node:create', 'node:update', 'edge:read', 'edge:create'];

export const LIFECYCLE: NonNullable<PluginManifest['lifecycle']> = {
    persistence: 'opt-in',
    controls: ['progress', 'cancel'],
    progress: 'determinate',
};

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function requireNet(ctx: HostContext): void {
    if (!ctx.net?.fetch) throw new Error('This plugin was not granted its network permission');
}

/** The selected nodes of `type`, and how many selected nodes were something else. */
export async function selectedOfType(ctx: HostContext, type: string): Promise<{ nodes: GraphNode[]; other: number }> {
    const nodes: GraphNode[] = [];
    let other = 0;
    for (const id of ctx.input?.selection ?? []) {
        if (ctx.signal?.aborted) throw abortErr();
        const n = await ctx.graph?.get?.(id);
        if (n && n.type === type) nodes.push(n);
        else other++;
    }
    return { nodes, other };
}

/**
 * Why a selected node is not looked up, by its `network`: one the pack covers passes (null);
 * `unknown` and `evm` have no established chain; anything else is a chain Blockchair is not asked
 * about here. The counts end up in the summary, so a run on a mixed selection says what it skipped.
 */
export function networkOf(n: GraphNode): { network: Network | null; skip: 'unestablished' | 'other' | null; name: string } {
    const name = str(n.data?.network);
    if (isCovered(name)) return { network: name, skip: null, name };
    if (!name || name === 'unknown' || name === 'evm') return { network: null, skip: 'unestablished', name: name || 'unknown' };
    return { network: null, skip: 'other', name };
}

/** Lines about the nodes a run skipped, for its summary. */
export function skippedLines(unestablished: number, others: Map<string, number>, wrongType: number, kind: string): string[] {
    const out: string[] = [];
    if (unestablished) {
        out.push(`${unestablished} ${kind} node(s) have no established network (unknown or evm) — run Blockchair Network Check on an unknown address first`);
    }
    if (others.size) {
        const list = [...others.entries()].map(([n, c]) => `${n} ${c}`).join(', ');
        out.push(`${[...others.values()].reduce((a, b) => a + b, 0)} on networks Blockchair is not asked about here (${list})`);
    }
    if (wrongType) out.push(`${wrongType} selected node(s) are another type`);
    return out;
}

/**
 * What to say about a StopRun: rethrow when nothing was staged yet, otherwise the line the summary
 * ends with. See StopRun for why the two differ. With nothing left unreached (a stop at the last
 * request) the line names the cause only; the plugin's own lines say what to run again.
 */
export function stopped(e: StopRun, wroteSomething: boolean, notReached: number, what: string): string {
    if (!wroteSomething) throw new Error(e.message);
    return notReached > 0 ? `STOPPED: ${e.message}. ${notReached} ${what} were not looked up — run them again later` : `STOPPED: ${e.message}`;
}

/** Fixed-size groups, in order. */
export function chunks<T>(xs: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
    return out;
}

/** An integer param clamped to [min, max], or its default. */
export function intParam(ctx: HostContext, name: string, def: number, min: number, max: number): number {
    const v = Math.floor(Number(ctx.params?.[name]));
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
}

/**
 * A createNode refusal, turned into what to do about it. The host refuses a type no installed type
 * pack defines and a value outside a property's enum; with this pack the cause is the
 * Cryptocurrency type pack — missing, or a release without a `network` value the run writes.
 */
export function typePackHint(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not defined by any installed typepack/i.test(msg)) return 'install the Cryptocurrency type pack in this project';
    if (/must be one of/i.test(msg)) return 'update the Cryptocurrency type pack in this project';
    return msg;
}

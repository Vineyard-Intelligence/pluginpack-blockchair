// Blockchair Network Check — which of the seven networks an `unknown` address has been used on.
//
// A legacy `1…` or `3…` is the same bytes on Bitcoin, Bitcoin Cash and Bitcoin SV, and a `3…` is
// also Litecoin's old P2SH prefix; history from before each split is on both sides of it. The type
// pack keeps such a value as `unknown` until something settles it, and asks for a node on each
// network it is established on, linked `same address on` from the unknown one. This asks Blockchair
// about every network the string is valid on, in one multi-address request per network.
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import { CHAINS, candidates, queryForm } from './address';
import type { Candidate, Network } from './address';
import { Blockchair, abortErr, requireKey } from './client';
import { ADDRESS, KEY_CONFIG, LIFECYCLE, NETWORK, PLATFORMS, crypto, requireNet, selectedOfType, str, stopped, typePackHint } from './common';
import { addressFields, asOf } from './fields';
import { Links } from './graph';
import { lookupAddresses } from './lookup';
import type { AddressBatch } from './lookup';
import { points } from './values';

const SAME = 'same address on';

interface Probe {
    id: string;
    raw: string;
    list: Candidate[];
    outside: string[];
}

export const networkCheck = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.blockchair_network_check',
        content_type: 'vineyard:plugin',
        name: 'Blockchair Network Check',
        version: '1.0.0',
        description:
            "For each selected Crypto Address whose network is unknown, asks Blockchair on every network the string is a valid address on — Bitcoin, Bitcoin Cash, Litecoin, Bitcoin SV, Dogecoin, Dash, Zcash — whether it has been used there. Each network with activity gets its own Crypto Address (in that network's form: CashAddr on Bitcoin Cash, M… for a Litecoin 3…) with the fields Blockchair Address Summary writes, linked 'same address on' from the unknown one with how it was decided (check_blockchair). A format only one network has is settled without activity. The unknown node itself is not changed. Needs a Blockchair API key.",
        icon: 'scan-search',
        platforms: PLATFORMS,
        io: { consumes: [crypto('crypto_address')], produces: [crypto('crypto_address')] },
        scopes: { graph: ['node:read', 'node:create', 'edge:read', 'edge:create'], network: NETWORK, config: [KEY_CONFIG] },
        lifecycle: LIFECYCLE,
    },

    async run(ctx: HostContext): Promise<RunResult> {
        requireNet(ctx);
        const { nodes, other } = await selectedOfType(ctx, ADDRESS);
        const probes: Probe[] = [];
        let established = 0;
        let noFormat = 0;
        for (const n of nodes) {
            const net = str(n.data?.network);
            if (net && net !== 'unknown') {
                established++;
                continue;
            }
            const raw = str(n.data?.address);
            const c = candidates(raw);
            if (!c.list.length) {
                noFormat++;
                continue;
            }
            probes.push({ id: n.id, raw, ...c });
        }
        const skipped: string[] = [];
        if (established) skipped.push(`${established} address(es) already have a network (this plugin checks unknown ones)`);
        if (noFormat) skipped.push(`${noFormat} unknown address(es) are not a valid address on any network Blockchair covers`);
        if (other) skipped.push(`${other} selected node(s) are another type`);
        if (!probes.length) {
            return { summary: `Select Crypto Address nodes whose network is unknown first${skipped.length ? `: ${skipped.join('; ')}` : ''}.`, counts: { checked: 0, settled: 0 } };
        }
        const client = new Blockchair(ctx, requireKey(ctx));

        // One multi-address request per network, over every probe that is valid there.
        const forms = new Map<Network, string[]>();
        for (const p of probes) for (const c of p.list) (forms.get(c.network) ?? forms.set(c.network, []).get(c.network)!).push(queryForm(c.network, c.address));
        const answers = new Map<Network, AddressBatch>();
        let stop: AddressBatch['stop'];
        let i = 0;
        for (const [network, list] of forms) {
            if (ctx.signal?.aborted) throw abortErr();
            ctx.progress?.set?.({ percent: Math.round((i++ / forms.size) * 80), message: `Blockchair: ${CHAINS[network].label}` });
            const res = await lookupAddresses(client, network, list);
            answers.set(network, res);
            if (res.stop) {
                stop = res.stop;
                break;
            }
        }

        // 'restate': what a link says can change between runs (see Links) — a format-settled
        // address that is later used becomes `activity`, and the date moves.
        const links = new Links(ctx, 'restate');
        let settled = 0;
        let unsettled = 0;
        let made = 0;
        let typeProblem = '';
        let partly = 0;
        const open: string[] = [];
        const shared: string[] = [];
        for (const p of probes) {
            if (ctx.signal?.aborted) throw abortErr();
            const active: Candidate[] = [];
            const unanswered: Network[] = [];
            for (const c of p.list) {
                const res = answers.get(c.network);
                const q = queryForm(c.network, c.address);
                if (res?.found.has(q)) active.push(c);
                else if (!res?.unused.has(q)) unanswered.push(c.network);
            }
            // Settled by format: one covered network has this format and no other network in the type
            // pack shares it. Then a never-used address is still that network's, as the type pack's
            // writers are told to record it.
            const byFormat = p.list.length === 1 && p.outside.length === 0 && !active.length ? p.list : [];
            if (unanswered.length) partly++;
            const settle = [...active.map((c) => ({ c, basis: 'activity' })), ...byFormat.map((c) => ({ c, basis: 'format' }))];
            if (!settle.length) {
                unsettled++;
                if (open.length < 3) {
                    const unused = p.list.filter((c) => !unanswered.includes(c.network)).map((c) => CHAINS[c.network].label);
                    const said = [
                        unused.length ? `never used on ${unused.join(', ')}` : '',
                        unanswered.length ? `no answer for ${unanswered.map((n) => CHAINS[n].label).join(', ')}` : '',
                        p.outside.length ? `it may also be ${p.outside.join(', ')}, which Blockchair does not cover` : '',
                    ].filter(Boolean);
                    open.push(`${p.raw}: ${said.join('; ')}`);
                }
                continue;
            }
            settled++;
            if (active.length > 1 && shared.length < 3) shared.push(`${p.raw} on ${active.map((c) => CHAINS[c.network].label).join(' and ')}`);
            try {
                for (const { c, basis } of settle) {
                    const res = answers.get(c.network);
                    const hit = res?.found.get(queryForm(c.network, c.address));
                    const when = asOf(res?.context);
                    const data: Record<string, unknown> = { network: c.network, address: c.address, ...(hit ? addressFields(hit, c.kind, when) : { address_kind: c.kind }) };
                    const node = await ctx.graph!.createNode!({ type: ADDRESS, data });
                    made++;
                    // Under a key of this source's own, the type pack's rule for figures from
                    // different sources: commit merges link data by top-level key, so a shared
                    // `basis` would be overwritten by the next source to settle the same pair (OFAC
                    // Address Screening writes one), leaving its verdict beside this run's date and
                    // candidates, and this run's restate would overwrite that source in turn.
                    await links.link(p.id, String(node.id), SAME, {
                        check_blockchair: {
                            basis,
                            as_of: when.slice(0, 10),
                            ...(basis === 'activity' && p.list.length > 1 ? { candidates: p.list.map((x) => x.network) } : {}),
                        },
                    });
                }
            } catch (e) {
                typeProblem = typePackHint(e);
                break;
            }
        }
        ctx.progress?.set?.({ percent: 100 });

        const parts = [`${settled} of ${probes.length} unknown address(es) settled, ${made} network node(s)`];
        if (shared.length) parts.push(`used on more than one network — separate accounts that share a string: ${shared.join('; ')}`);
        if (unsettled) parts.push(`${unsettled} not settled (${open.join(' | ')}${unsettled > open.length ? ' | …' : ''})`);
        if (typeProblem) parts.push(`STOPPED: ${typeProblem}`);
        parts.push(...skipped);
        parts.push(`${points(client.cost)} Blockchair request point(s) used`);
        if (partly && !stop) parts.push(`${partly} address(es) could not be checked on every network (a request failed): run them again`);
        if (stop) parts.push(stopped(stop, made > 0, partly, 'address(es) on some of their networks'));
        return {
            summary: client.say(parts.join('. ') + '.'),
            counts: { checked: probes.length, settled, unsettled, nodes: made },
        };
    },
});

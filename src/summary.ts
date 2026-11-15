// Blockchair Address Summary — balance, first and last use, totals received and spent, for up to
// 100 addresses per request.
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import { CHAINS } from './address';
import { Blockchair, abortErr, requireKey } from './client';
import { ADDRESS, KEY_CONFIG, LIFECYCLE, NETWORK, PLATFORMS, UPDATE_SCOPES, crypto, requireNet, selectedOfType, stopped, typePackHint } from './common';
import { addressFields, asOf, unusedFields } from './fields';
import { lookupAddresses } from './lookup';
import { addressTargets, byNetwork } from './targets';
import { delta, points } from './values';

export const summary = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.blockchair_address_summary',
        content_type: 'vineyard:plugin',
        name: 'Blockchair Address Summary',
        version: '1.0.0',
        description:
            'Looks up each selected Crypto Address on Bitcoin, Bitcoin Cash, Litecoin, Bitcoin SV, Dogecoin, Dash or Zcash in Blockchair, 100 per request, and writes its confirmed balance (balance_as_of, balance_source), first_seen and last_seen, address_kind, and the totals and dates Blockchair alone gives: blockchair_received, blockchair_spent, blockchair_first_received, blockchair_last_received, blockchair_first_spent, blockchair_last_spent and blockchair_output_count. An address never used on its network gets a zero balance and blockchair_output_count 0. Nothing is created. Needs a Blockchair API key.',
        icon: 'wallet',
        platforms: PLATFORMS,
        io: { consumes: [crypto('crypto_address')], produces: [] },
        scopes: { graph: UPDATE_SCOPES, network: NETWORK, config: [KEY_CONFIG] },
        lifecycle: LIFECYCLE,
    },

    async run(ctx: HostContext): Promise<RunResult> {
        requireNet(ctx);
        const { nodes, other } = await selectedOfType(ctx, ADDRESS);
        const { targets, skipped } = addressTargets(nodes, other);
        if (!targets.length) {
            const why = skipped.length ? `: ${skipped.join('; ')}` : '';
            return { summary: `Select Crypto Address nodes on a network Blockchair covers first${why}.`, counts: { checked: 0, seen: 0, unused: 0 } };
        }
        const client = new Blockchair(ctx, requireKey(ctx));
        let seen = 0;
        let unused = 0;
        let failed = 0;
        let updated = 0;
        let looked = 0;
        let refused = 0;
        let refusal = '';
        let stop = '';
        const respelled = targets.filter((t) => t.respelled).length;
        const groups = [...byNetwork(targets).entries()];
        for (let g = 0; g < groups.length; g++) {
            if (ctx.signal?.aborted) throw abortErr();
            const [network, list] = groups[g];
            ctx.progress?.set?.({ percent: Math.round((looked / targets.length) * 100), message: `Blockchair: ${list.length} ${CHAINS[network].label} address(es)` });
            const res = await lookupAddresses(client, network, list.map((t) => t.query));
            const when = asOf(res.context);
            // Addresses the stop cut off are "not reached", not failures: the STOPPED line counts them.
            const cut = (why: string | undefined) => why === 'not reached' || (res.stop !== undefined && why === res.stop.message);
            for (const t of list) {
                const hit = res.found.get(t.query);
                if (hit || res.unused.has(t.query)) looked++;
                let patch: Record<string, unknown>;
                if (hit) {
                    seen++;
                    patch = addressFields(hit, t.kind, when);
                } else if (res.unused.has(t.query)) {
                    unused++;
                    patch = unusedFields(t.kind, when);
                } else {
                    if (!cut(res.failed.get(t.query))) {
                        failed++;
                        ctx.progress?.log?.(`${t.node.id}: ${res.failed.get(t.query) ?? 'no answer'}`);
                    }
                    continue;
                }
                const d = delta(t.node.data, patch);
                if (!Object.keys(d).length) continue;
                try {
                    await ctx.graph!.updateNode!(t.node.id, d);
                    updated++;
                } catch (e) {
                    // The project refused the write (its type pack, a node gone mid-run): this node's
                    // problem, not the run's.
                    refused++;
                    refusal ||= typePackHint(e);
                }
            }
            if (res.stop) {
                stop = stopped(res.stop, updated > 0, targets.length - looked - failed, 'address(es)');
                break;
            }
        }
        ctx.progress?.set?.({ percent: 100 });

        const parts = [`${seen + unused} of ${targets.length} address(es) looked up on Blockchair: ${seen} used, ${unused} never used on their network`];
        if (updated + refused < seen + unused) parts.push(`${seen + unused - updated - refused} already held these values`);
        if (refused) parts.push(`${refused} update(s) refused by the project (${refusal})`);
        if (respelled) parts.push(`${respelled} written in a non-canonical form (a legacy Bitcoin Cash address, a Litecoin 3…) were looked up in the canonical one`);
        if (failed) parts.push(`${failed} lookup(s) failed`);
        parts.push(...skipped);
        parts.push(`${points(client.cost)} Blockchair request point(s) used`);
        if (stop) parts.push(stop);
        return {
            summary: client.say(parts.join('. ') + '.'),
            counts: { checked: targets.length, seen, unused, updated, failed, refused },
        };
    },
});

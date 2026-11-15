// Live check against the real Blockchair API — opt-in, never part of the mock suite.
//
//   BLOCKCHAIR_API_KEY=… node live-test.mjs
//
// NEVER RUN YET: no key was available when the pack was written (2026-11-15), so everything the
// mock suite assumes about Blockchair's answers comes from its documentation. This script is the
// list of those assumptions, checked against the live API: each line is PASS or FAIL, and a FAIL
// means the code (and the mock answers) must follow the API rather than the docs.
//
// The key is read from the environment only, sent only as Blockchair's `?key=`, and never printed:
// nothing below logs a URL. About 18 requests, roughly 38 request points (10 of them for the one
// outputs-table query that finds a Litecoin P2SH address to ask about).
import { createHash } from 'node:crypto';
import pack from './dist/pack.mjs';

const key = (process.env.BLOCKCHAIR_API_KEY ?? '').trim();
if (!key) {
    console.log('SKIP live test: set BLOCKCHAIR_API_KEY (a Blockchair Premium API key)');
    process.exit(0);
}
const P = Object.fromEntries(pack.plugins.map((p) => [p.manifest.identifier.replace('run.vineyard.plugins.blockchair_', ''), p]));
const ok = [];
const fail = [];
const check = (name, cond, detail = '') => {
    (cond ? ok : fail).push(name);
    console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const raw = []; // decoded answers, for the shape checks below
// `rewrite` changes the path of every request of one run — used once, to send a run to a route
// Blockchair does not serve.
let rewrite = null;
const net = {
    async fetch(url) {
        if (rewrite) url = rewrite(url);
        const res = await fetch(url);
        const text = await res.text();
        try {
            raw.push({ path: new URL(url).pathname, status: res.status, json: JSON.parse(text) });
        } catch {
            raw.push({ path: new URL(url).pathname, status: res.status, json: null });
        }
        const headers = Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
        return { ok: res.ok, status: res.status, headers, async text() { return text; }, async json() { return JSON.parse(text); } };
    },
};
// `drawn` is what the run linked; `edges` is the host method (the project has no edges yet). They
// used to share the name `edges`, and the later key won: the Transaction check below threw
// "graph.edges.filter is not a function" before the last two sections could run.
function graphOf(nodes) {
    const created = [];
    const drawn = [];
    const updates = [];
    return {
        created,
        drawn,
        updates,
        get: async (id) => nodes[id] ?? created.find((n) => n.id === id) ?? null,
        list: async () => ({ nodes: [] }),
        edges: async () => [],
        createNode: async (d) => {
            const n = { id: `n${created.length + 1}`, type: d.type, data: d.data };
            created.push(n);
            return n;
        },
        updateNode: async (id, data) => updates.push({ id, data }),
        createEdge: async (e) => drawn.push(e),
    };
}
async function runOn(name, nodes, params = {}) {
    const graph = graphOf(nodes);
    raw.length = 0;
    const ctx = { run: { platform: 'desktop' }, config: { api_key: key }, params, input: { selection: Object.keys(nodes) }, graph, net, progress: { set() {}, log: (m) => console.log(`    log: ${m}`) } };
    const r = await P[name].run(ctx);
    console.log(`  ${P[name].manifest.name}: ${r.summary}`);
    return { r, graph, answers: [...raw] };
}
const A = 'cryptocurrency.crypto_address';
const T = 'cryptocurrency.crypto_transaction';
const GENESIS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const EATER = '1BitcoinEaterAddressDontSendf59kuE'; // a burn address with a valid checksum, and many deposits
const TX170 = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';
const LTC = 'LNAifc8nfjtDJ8azRPiancbZSBftPzhfzb'; // Blockchair's own Litecoin example

// A P2PKH address no one has used: the hash is SHA-256 of a fixed phrase, so its checksum is valid
// and the chance it was ever paid is nil.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha = (b) => createHash('sha256').update(b).digest();
function b58check(payload) {
    const buf = Buffer.concat([payload, sha(sha(payload)).subarray(0, 4)]);
    let n = BigInt('0x' + buf.toString('hex'));
    let out = '';
    while (n > 0n) {
        out = B58[Number(n % 58n)] + out;
        n /= 58n;
    }
    for (const b of buf) {
        if (b !== 0) break;
        out = '1' + out;
    }
    return out;
}
const UNUSED = b58check(Buffer.concat([Buffer.from([0]), sha('vineyard blockchair live-test: never used').subarray(0, 20)]));

console.log('Finding a Litecoin P2SH address (outputs table, 10 points)');
let LTC_M = null;
{
    let status = 'no answer';
    try {
        const res = await fetch(`https://api.blockchair.com/litecoin/outputs?${new URLSearchParams({ q: 'type(scripthash)', limit: '1', key })}`);
        status = `HTTP ${res.status}`;
        const json = await res.json().catch(() => null);
        LTC_M = String(json?.data?.[0]?.recipient ?? '') || null;
    } catch {
        /* reported below; the error is not printed because it could carry the URL, key and all */
    }
    check('a Litecoin P2SH output is listed, and its recipient is in the M… form', /^M/.test(LTC_M ?? ''), LTC_M ?? status);
}

console.log('Address Summary — bitcoin (one never used), bitcoin_cash (legacy spelling), litecoin (L… and M…), bitcoin_sv');
{
    const nodes = {
        a: { id: 'a', type: A, data: { network: 'bitcoin', address: GENESIS } },
        b: { id: 'b', type: A, data: { network: 'bitcoin', address: EATER } },
        z: { id: 'z', type: A, data: { network: 'bitcoin', address: UNUSED } },
        c: { id: 'c', type: A, data: { network: 'bitcoin_cash', address: GENESIS } },
        l: { id: 'l', type: A, data: { network: 'litecoin', address: LTC } },
        s: { id: 's', type: A, data: { network: 'bitcoin_sv', address: GENESIS } },
    };
    if (LTC_M) nodes.m = { id: 'm', type: A, data: { network: 'litecoin', address: LTC_M } };
    const { graph, answers } = await runOn('address_summary', nodes);
    const up = (id) => graph.updates.find((u) => u.id === id)?.data ?? {};
    const btc = answers.find((x) => x.path.startsWith('/bitcoin/'));
    const listed = btc?.json?.data?.addresses ?? {};
    const keys = Object.keys(listed);
    check('the 100-address dashboard keys data.addresses by the address as asked', keys.includes(GENESIS), keys.join(', '));
    check('…and its entries carry no transaction_count', !('transaction_count' in (listed[GENESIS] ?? {})));
    // The docs: data.addresses "don't include addresses which don't participate in transactions".
    // lookup.ts also reads an entry listed with nothing received as unused, so either passes.
    check('a never-used address is left out of data.addresses (or listed with nothing received)', !(UNUSED in listed) || Number(listed[UNUSED]?.output_count) === 0, UNUSED in listed ? 'listed' : 'left out');
    check('…and the pack writes it as never used', up('z').balance === '0' && up('z').blockchair_output_count === 0 && !('first_seen' in up('z')), JSON.stringify(up('z')));
    const bch = answers.find((x) => x.path.startsWith('/bitcoin-cash/'));
    check('Bitcoin Cash answers a CashAddr query', bch?.status === 200 && !!up('c').balance, `keys: ${Object.keys(bch?.json?.data?.addresses ?? {}).join(', ')}`);
    const ltc = answers.find((x) => x.path.startsWith('/litecoin/'));
    const ltcKeys = Object.keys(ltc?.json?.data?.addresses ?? {});
    check('Litecoin answers an L… address under its own form', ltcKeys.includes(LTC) && !!up('l').balance, ltcKeys.join(', '));
    if (LTC_M) check('Litecoin answers an M… address under its own form', ltcKeys.includes(LTC_M) && !!up('m').balance, ltcKeys.join(', '));
    const bsv = answers.find((x) => x.path.startsWith('/bitcoin-sv/'));
    check('Bitcoin SV answers a legacy address under its own form', bsv?.status === 200 && Object.keys(bsv?.json?.data?.addresses ?? {}).includes(GENESIS) && !!up('s').balance, `HTTP ${bsv?.status}`);
    check('request_cost is in context', answers.every((x) => typeof x.json?.context?.request_cost === 'number'));
    check('cache.since is in context', answers.every((x) => typeof x.json?.context?.cache?.since === 'string'));
    check('the genesis address has a balance written', !!up('a').balance);
}

console.log('Address Summary — a route Blockchair does not serve');
{
    // What the 404 handling rests on: a 404 for a route is a failed lookup, never "never used".
    rewrite = (url) => url.replace('/bitcoin/dashboards/addresses/', '/bitcoin/dashboards/no-such-endpoint/');
    const { r, graph, answers } = await runOn('address_summary', { a: { id: 'a', type: A, data: { network: 'bitcoin', address: GENESIS } } });
    rewrite = null;
    check('a 404 for an unknown route is a failed lookup with nothing written', r.counts.failed === 1 && r.counts.unused === 0 && graph.updates.length === 0, `HTTP ${answers[0]?.status}, context.error: ${JSON.stringify(answers[0]?.json?.context?.error ?? null)}`);
}

console.log('Address Transactions — bitcoin 12cbQLTF…, 2 transactions');
{
    const { graph, answers } = await runOn('address_transactions', { s: { id: 's', type: A, data: { network: 'bitcoin', address: '12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S' } } }, { max_transactions: 2 });
    const dash = answers[0]?.json?.data ?? {};
    const entry = Object.values(dash)[0];
    check('the single-address dashboard has transaction_count', Number.isInteger(entry?.address?.transaction_count));
    check('transaction_details gives objects with hash and time', Array.isArray(entry?.transactions) && typeof entry.transactions[0]?.hash === 'string' && typeof entry.transactions[0]?.time === 'string');
    check('two transactions were drawn', graph.created.filter((n) => n.type === T).length === 2);
    const s = graph.updates.find((u) => u.id === 's')?.data ?? {};
    check('…and the address says how much of its history the graph holds', s.history_examined === 2 && s.history_complete === (s.tx_count <= 2), JSON.stringify({ tx_count: s.tx_count, history_examined: s.history_examined, history_complete: s.history_complete }));
}

console.log('Transaction — the first bitcoin transfer (block 170)');
{
    const { graph, answers } = await runOn('transaction', { t: { id: 't', type: T, data: { network: 'bitcoin', tx_hash: TX170 } } });
    const tx = answers[0]?.json?.data?.[TX170];
    check('inputs are spent outputs with spending_index and transaction_hash', Number.isInteger(tx?.inputs?.[0]?.spending_index) && typeof tx?.inputs?.[0]?.transaction_hash === 'string');
    check('two outputs drawn, one input', graph.drawn.filter((e) => e.from === 't').length === 2 && graph.drawn.filter((e) => e.to === 't').length === 1);
}

console.log('Address Transactions — bitcoin_cash genesis (recipient format)');
{
    const { answers } = await runOn('address_transactions', { c: { id: 'c', type: A, data: { network: 'bitcoin_cash', address: GENESIS } } }, { max_transactions: 1 });
    const txs = answers.find((x) => x.path.includes('/dashboards/transactions/'))?.json?.data ?? {};
    const sample = Object.values(txs)[0]?.outputs?.map((o) => o.recipient) ?? [];
    check('Bitcoin Cash recipients are CashAddr without the prefix (or the pack converts them)', sample.length > 0, sample.slice(0, 3).join(', '));
}

console.log('Address Summary — a SegWit v2 address beside a known one');
{
    // The validator accepts witness versions 2–16 (BIP-350), newer than Blockchair's docs. If
    // Blockchair refuses the format with a 400, lookup.ts splits the batch so the genesis address
    // beside it is still looked up; either way, which it is should be written down.
    const V2 = 'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs'; // BIP-350's version-2 test vector
    const { r, answers } = await runOn('address_summary', { g: { id: 'g', type: A, data: { network: 'bitcoin', address: GENESIS } }, z: { id: 'z', type: A, data: { network: 'bitcoin', address: V2 } } });
    const refused = answers.some((x) => x.status === 400);
    check('a format newer than the docs does not cost the address beside it its lookup', r.counts.seen >= 1, refused ? 'Blockchair answered 400; the batch was split' : 'no 400: Blockchair takes the format');
}

console.log('Network Check — the genesis address as unknown');
{
    const { r } = await runOn('network_check', { u: { id: 'u', type: A, data: { network: 'unknown', address: GENESIS } } });
    check('settled on Bitcoin, Bitcoin Cash and Bitcoin SV', r.counts.nodes === 3, `${r.counts.nodes} node(s)`);
}

console.log(`\n${fail.length ? 'FAIL' : 'PASS'} ${ok.length} / ${ok.length + fail.length}`);
if (fail.length) process.exit(1);

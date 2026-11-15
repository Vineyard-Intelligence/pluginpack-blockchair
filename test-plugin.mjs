// Mock tests for the Blockchair pack — no network, no app.
//   Run: node test-plugin.mjs [bundle]      (and node test/pure.test.mjs for the pure modules)
//
// NOT VERIFIED AGAINST THE LIVE API. No Blockchair key was available. Response shapes come from
// Blockchair's API documentation v2.0.80 (test/fixtures/docs-*.json are its examples, verbatim but
// for the elided `...`), or are built here in the same shape; the two error bodies
// (test/fixtures/measured-*.json) are real answers measured on 2026-11-14 without a usable key.
// Inline answers marked SHAPED are made up in the documented shape; their hashes are synthetic.
// The API key here is a placeholder: a real key never comes near this file.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const pack = (await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : './dist/pack.mjs')).default;
const P = Object.fromEntries(pack.plugins.map((p) => [p.manifest.identifier.replace('run.vineyard.plugins.blockchair_', ''), p]));
const fixture = (name) => readFileSync(join(here, 'test', 'fixtures', name), 'utf8');

const ok = [];
const fail = [];
const check = (name, cond) => (cond ? ok : fail).push(name);

const KEY = 'test-key-not-real';
const ADDRESS = 'cryptocurrency.crypto_address';
const TX = 'cryptocurrency.crypto_transaction';

// ---- address helpers (node:crypto, independent of the pack's own codec) -----------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha = (b) => createHash('sha256').update(b).digest();
function b58check(payload) {
    const buf = Buffer.concat([payload, sha(sha(payload)).subarray(0, 4)]);
    let n = BigInt('0x' + buf.toString('hex'));
    let s = '';
    while (n > 0n) {
        s = B58[Number(n % 58n)] + s;
        n /= 58n;
    }
    for (const b of buf) {
        if (b !== 0) break;
        s = '1' + s;
    }
    return s;
}
const p2pkh = (i, version = 0) => b58check(Buffer.concat([Buffer.from([version]), Buffer.from(i.toString(16).padStart(40, '0'), 'hex')]));

const GENESIS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const GENESIS_BCH = 'qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy';
const SATOSHI = '12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S';
const HAL = '1Q2TWHE3GMdB6BZKafqwxXtWAWgFt5Jvm3';
const UNUSED = '1EfgV2Hr5CDjXPavHDpDMjmU33BA2veHy6';
const P2SH = '3FdhDDr42mMXX4tpG6dPkHuoCrPTJk3yjH';
const TX170 = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';
const SHAPED_TX = '5a'.repeat(32);

// ---- mock host ---------------------------------------------------------------------------------
// Mirrors the host closely enough for these tests: createNode de-duplicates by type and identity
// (network + address folded the way the type pack folds hex, bech32 and CashAddr; network + hash
// without 0x, lower case) and fill-merges onto the node it finds; updateNode fill-merges.
const foldAddr = (a) => {
    const s = String(a ?? '');
    if (/^(0x|bc1|ltc1|bitcoincash:)/i.test(s) || (/^[qpzr]/i.test(s) && (s.length === 42 || s.length === 61))) return s.toLowerCase().replace(/^bitcoincash:/, '');
    return s;
};
const identity = (type, d) =>
    type === ADDRESS ? `${type}|${d.network}|${foldAddr(d.address)}|${d.memo ?? ''}` : type === TX ? `${type}|${d.network}|${String(d.tx_hash ?? '').replace(/^0x/i, '').toLowerCase()}` : null;
const fillMerge = (a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b ?? {})) if (v !== null && v !== undefined && v !== '') out[k] = v;
    return out;
};

// `edges()` hands back what the app's host does: id, endpoints, label and the link's data
// (host-bridge.ts toEdge, frontend main 2026-11-16). `edgeData: false` is an older app, whose host
// handed back id, endpoints and label only (checked 2026-11-15). A mock that always passed the data
// hid that, on that app, every re-run restated every link.
function makeGraph(nodeById, liveEdges = [], edgeData = true) {
    const createdNodes = [];
    const createdEdges = [];
    const updates = [];
    const edgeUpdates = [];
    const all = () => [...Object.values(nodeById), ...createdNodes];
    return {
        createdNodes,
        createdEdges,
        updates,
        edgeUpdates,
        async get(id) {
            return all().find((n) => n.id === id) ?? null;
        },
        async list(o) {
            return { nodes: o?.type ? all().filter((n) => n.type === o.type) : all() };
        },
        async edges() {
            return edgeData ? liveEdges : liveEdges.map(({ data, ...e }) => e);
        },
        async createNode(d) {
            const key = identity(d.type, d.data);
            const existing = key && all().find((n) => identity(n.type, n.data) === key);
            if (existing) {
                existing.data = fillMerge(existing.data, d.data);
                return existing;
            }
            const n = { id: `n${createdNodes.length + 1}`, type: d.type, data: { ...d.data } };
            createdNodes.push(n);
            return n;
        },
        async updateNode(id, data) {
            updates.push({ id, data });
            const n = all().find((x) => x.id === id);
            if (n) n.data = fillMerge(n.data, data);
        },
        async createEdge(e) {
            createdEdges.push(e);
        },
        async updateEdge(id, patch) {
            edgeUpdates.push({ id, patch });
        },
    };
}

/** respond(url: URL) → { status, body } (an object, serialised), { status, text } or a thrown Error. */
function makeNet(respond) {
    const calls = [];
    return {
        calls,
        async fetch(url, init) {
            const u = new URL(url);
            calls.push({ url, u, init });
            const r = respond(u);
            if (r instanceof Error) throw r;
            const text = r.text ?? JSON.stringify(r.body ?? {});
            return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: r.headers ?? {}, async text() { return text; }, async json() { return JSON.parse(text); } };
        },
    };
}

const ctxFor = ({ nodes = {}, edges = [], edgeData = true, selection = Object.keys(nodes), respond = () => ({ status: 500 }), config = { api_key: `  ${KEY}  ` }, params = {}, platform = 'web', net = true }) => {
    const graph = makeGraph(nodes, edges, edgeData);
    const n = makeNet(respond);
    const logs = [];
    const ctx = { run: { platform }, signal: new AbortController().signal, config, params, input: { selection }, graph, net: net ? n : undefined, progress: { set() {}, log: (m) => logs.push(m) } };
    return { ctx, graph, net: n, logs };
};
const run = async (p, t) => {
    try {
        return await p.run(t.ctx);
    } catch (e) {
        return { error: e };
    }
};
const addr = (id, network, address, extra = {}) => ({ id, type: ADDRESS, data: { network, address, ...extra } });
const pathOf = (c) => decodeURIComponent(c.u.pathname);
const ok200 = (data, context = {}) => ({ status: 200, body: { data, context: { code: 200, request_cost: 1, ...context } } });
const quota402 = { status: 402, body: { data: null, context: { code: 402, error: 'API key limit exceeded' } } };

// A virtual clock for the time budget. Date.now and setTimeout are replaced while `fn` runs: a wait
// moves the clock instead of passing, and `tick(ms)` stands for a request's round trip. The host
// ends a plugin run at 10 minutes and keeps nothing it staged (worker-host.ts, runner.ts).
const HOST_LIMIT_MS = 10 * 60_000;
async function withClock(fn) {
    const realNow = Date.now;
    const realSetTimeout = globalThis.setTimeout;
    const start = realNow();
    let now = start;
    Date.now = () => now;
    globalThis.setTimeout = (f, ms, ...a) => {
        now += Math.max(0, Number(ms) || 0);
        return realSetTimeout(f, 0, ...a);
    };
    try {
        return await fn({ tick: (ms) => (now += ms), elapsed: () => now - start });
    } finally {
        Date.now = realNow;
        globalThis.setTimeout = realSetTimeout;
    }
}
const hashOf = (...parts) => createHash('sha256').update(parts.join(':')).digest('hex');
/** A Blockchair transaction entry with no inputs or outputs, for runs that only count requests. */
const bareTx = (h) => ({ transaction: { block_id: 1, hash: h, time: '2020-01-01 00:00:00', is_coinbase: false, fee: 0 }, inputs: [], outputs: [] });

// ================================================================ manifests
{
    const json = JSON.parse(readFileSync(join(here, 'plugins', 'blockchair.manifest.json'), 'utf8'));
    const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
    check('manifest: generated from this bundle (run gen-manifest.mjs)', stable(json) === stable({ ...pack, plugins: pack.plugins.map((p) => p.manifest) }));
    check('pack identifier ends in [a-z0-9_]+', /^run\.vineyard\.pluginpacks\.[a-z0-9_]+$/.test(pack.identifier));
    check('pack summary fits the card (≤250)', pack.summary.length <= 250);
    // The pack-page rules (2026-11-09): about 400 to 1,500 characters; nothing about Vineyard itself
    // or a type pack, and no plugin parameters — the drawer lists those below the page.
    check(`pack page within the page rules (${pack.description.length} ≤ 1500)`, pack.description.length >= 400 && pack.description.length <= 1500 && !/type pack|typepack|max_|staging|sandbox|manifest|CORS/i.test(pack.description));
    const origins = (m) => [...new Set(m.scopes.network.map((n) => new URL(n.endpoint).origin))].sort().join(' ');
    for (const p of pack.plugins) {
        const m = p.manifest;
        check(`${m.name}: identifier ends in [a-z0-9_]+`, /^run\.vineyard\.plugins\.[a-z0-9_]+$/.test(m.identifier));
        check(`${m.name}: web is primary, both entries are the bundle`, m.platforms.primary === 'web' && m.platforms.web.entry === 'dist/pack.mjs' && m.platforms.desktop.entry === 'dist/pack.mjs');
        check(`${m.name}: version matches the pack`, m.version === pack.version);
        check(`${m.name}: the key is one required secret setting`, m.scopes.config.length === 1 && m.scopes.config[0].key === 'api_key' && m.scopes.config[0].secret === true && m.scopes.config[0].optional === false);
        // The app files settings by the set of origins a member calls: one set everywhere is what
        // makes the key one entry instead of four.
        check(`${m.name}: the same single origin as every other member`, origins(m) === 'https://api.blockchair.com' && m.scopes.network.every((n) => n.methods.join() === 'GET'));
        check(`${m.name}: creates iff it produces`, (m.io.produces.length > 0) === m.scopes.graph.includes('node:create'));
        check(`${m.name}: reads edges iff it draws them`, m.scopes.graph.includes('edge:create') === m.scopes.graph.includes('edge:read'));
        check(`${m.name}: description fits (≤1024)`, m.description.length <= 1024);
        check(`${m.name}: every type is the Cryptocurrency pack's`, [...m.io.consumes, ...m.io.produces].every((t) => t.typepack === 'run.vineyard.typepacks.cryptocurrency'));
    }
    check('the summary plugin creates nothing', P.address_summary.manifest.scopes.graph.join() === 'node:read,node:update');
}

// ================================================================ no key ships with the pack
// Blockchair's key format is not documented, so there is no shape to look for. What is checked: no
// fixture carries a key= value, and with BLOCKCHAIR_API_KEY set (the live test's variable) the exact
// value appears in no file. It is never printed.
{
    const files = [];
    const walk = (d) => {
        for (const f of readdirSync(d)) {
            if (f === 'node_modules' || f === '.git') continue;
            const p = join(d, f);
            if (statSync(p).isDirectory()) walk(p);
            else files.push(p);
        }
    };
    walk(here);
    const live = (process.env.BLOCKCHAIR_API_KEY ?? '').trim();
    const hits = files.filter((f) => {
        const s = readFileSync(f, 'utf8');
        return (f.includes(`${'/'}fixtures${'/'}`) && /[?&]key=/.test(s)) || (live && s.includes(live));
    });
    check(`no key in ${files.length} file(s)${live ? ' (and not the live key)' : ''}`, hits.length === 0);
    if (hits.length) console.log('  key in:', hits.map((f) => f.slice(here.length)).join(', '));
}

// ================================================================ refusals before any request
for (const p of pack.plugins) {
    const seed = p === P.transaction ? { t1: { id: 't1', type: TX, data: { network: 'bitcoin', tx_hash: TX170 } } } : { a1: addr('a1', p === P.network_check ? 'unknown' : 'bitcoin', GENESIS) };
    const t = ctxFor({ nodes: seed, config: {}, respond: () => ok200({}) });
    const r = await run(p, t);
    check(`${p.manifest.name}: no key → names the key, no request`, r.error && /Blockchair API key is not set/.test(r.error.message) && t.net.calls.length === 0);
    const t2 = ctxFor({ nodes: seed, net: false });
    const r2 = await run(p, t2);
    check(`${p.manifest.name}: no network permission → says so`, r2.error && /network permission/.test(r2.error.message));
}
{
    const nodes = {
        e1: addr('e1', 'ethereum', '0x19ddd94b94d3c68385c897846ab44ac99dbfae0f'),
        u1: addr('u1', 'unknown', GENESIS),
        b1: addr('b1', 'bitcoin', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb'),
        d1: { id: 'd1', type: 'infrastructure.domain', data: { domain_name: 'example.test' } },
    };
    const t = ctxFor({ nodes, respond: () => ok200({}) });
    const r = await P.address_summary.run(t.ctx);
    check('summary: nothing covered → no request, and each skip is named', t.net.calls.length === 0 && /no established network/.test(r.summary) && /ethereum 1/.test(r.summary) && /not a valid address/.test(r.summary) && /another type/.test(r.summary));
}

// ================================================================ Address Summary
const docsMulti = JSON.parse(fixture('docs-bitcoin-addresses.json'));
{
    const DOGE = p2pkh(0xd06e, 30);
    const nodes = {
        a1: addr('a1', 'bitcoin', GENESIS),
        a2: addr('a2', 'bitcoin', '12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX'),
        a3: addr('a3', 'bitcoin', UNUSED),
        c1: addr('c1', 'bitcoin_cash', GENESIS), // legacy spelling on a BCH node
        l1: addr('l1', 'litecoin', P2SH), // Litecoin's old 3… alias
        g1: addr('g1', 'dogecoin', DOGE),
    };
    const t = ctxFor({
        nodes,
        respond: (u) => {
            const p = decodeURIComponent(u.pathname);
            if (p.startsWith('/bitcoin/')) return { status: 200, body: { ...docsMulti, context: { ...docsMulti.context, request_cost: 1.2, cache: { since: '2026-11-14 12:00:00' } } } };
            // SHAPED: keyed by the prefixed CashAddr, to check a spelling difference still matches.
            if (p.startsWith('/bitcoin-cash/')) return ok200({ set: {}, addresses: { [`bitcoincash:${GENESIS_BCH}`]: { ...docsMulti.data.addresses[GENESIS], balance: 2699999000 } } });
            if (p.startsWith('/litecoin/')) {
                const m = p.split('/').pop();
                return ok200({ set: {}, addresses: { [m]: { balance: 1, received: 1, spent: 0, output_count: 1, first_seen_receiving: '2019-03-20 00:01:21', last_seen_receiving: '2019-03-20 00:01:21', first_seen_spending: null, last_seen_spending: null } } });
            }
            // SHAPED: a Dogecoin balance past 2^53 koinu, as raw JSON text so it reaches the pack unrounded.
            if (p.startsWith('/dogecoin/')) return { status: 200, text: `{"data":{"set":{},"addresses":{"${DOGE}":{"balance":15000000000000000123,"received":15000000000000000123,"spent":0,"output_count":3,"first_seen_receiving":"2021-05-08 01:02:03","last_seen_receiving":"2026-11-01 00:00:00","first_seen_spending":null,"last_seen_spending":null}}},"context":{"code":200,"request_cost":1}}` };
            return { status: 404, body: {} };
        },
    });
    const r = await P.address_summary.run(t.ctx);
    const calls = t.net.calls;
    check('summary: one request per network', calls.length === 4);
    const btc = calls.find((c) => pathOf(c).startsWith('/bitcoin/'));
    check('summary: the 100-address dashboard, confirmed only, no transaction lists', pathOf(btc) === `/bitcoin/dashboards/addresses/${GENESIS},12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX,${UNUSED}` && btc.u.searchParams.get('limit') === '0' && btc.u.searchParams.get('state') === 'latest');
    check('summary: the trimmed key rides as ?key= to api.blockchair.com only, with no headers', calls.every((c) => c.u.origin === 'https://api.blockchair.com' && c.u.searchParams.get('key') === KEY && !c.init));
    check('summary: a legacy BCH address is asked as CashAddr, an LTC 3… as M…', pathOf(calls.find((c) => pathOf(c).startsWith('/bitcoin-cash/'))).endsWith(`/${GENESIS_BCH}`) && /\/litecoin\/dashboards\/addresses\/M/.test(pathOf(calls.find((c) => pathOf(c).startsWith('/litecoin/')))));
    const u = (id) => t.graph.updates.find((x) => x.id === id)?.data ?? {};
    check('summary: balance, dates and totals', u('a1').balance === '68.12392291' && u('a1').first_seen === '2009-01-03T18:15:05Z' && u('a1').last_seen === '2019-10-24T18:47:23Z' && u('a1').blockchair_received === '68.12392291' && u('a1').blockchair_output_count === 1820);
    check('summary: balance_as_of is when Blockchair computed the answer', u('a1').balance_as_of === '2026-11-14T12:00:00Z' && u('a1').balance_source === 'Blockchair');
    check('summary: address_kind from the address format', u('a1').address_kind === 'p2pkh' && u('l1').address_kind === 'p2sh');
    check('summary: the 100-address dashboard has no tx_count, so none is written', !('tx_count' in u('a1')));
    check('summary: an unused address gets a zero balance and output count', u('a3').balance === '0' && u('a3').blockchair_output_count === 0 && !('tx_count' in u('a3')));
    check('summary: the BCH node matched under a prefixed key', u('c1').balance === '26.99999');
    check('summary: a Dogecoin balance past 2^53 is exact', u('g1').balance === '150000000000.00000123');
    check("summary: the selected nodes' own spellings are left alone", !('address' in u('c1')) && !('address' in u('l1')));
    check('summary: nothing is created', t.graph.createdNodes.length === 0 && t.graph.createdEdges.length === 0);
    check('summary: says what it did', /6 of 6 address\(es\) looked up on Blockchair: 5 used, 1 never used/.test(r.summary) && /2 written in a non-canonical form/.test(r.summary) && /4\.2 Blockchair request point\(s\) used/.test(r.summary));

    // A re-run that learns nothing new stages nothing. The mock merged the first run's updates into
    // `nodes`, so these copies hold what the first run wrote.
    const held = Object.fromEntries(['a1', 'a2', 'a3'].map((id) => [id, { ...nodes[id], data: { ...nodes[id].data } }]));
    const again = ctxFor({ nodes: held, respond: () => ({ status: 200, body: { ...docsMulti, context: { ...docsMulti.context, cache: { since: '2026-11-14 12:00:00' } } } }) });
    const r2 = await P.address_summary.run(again.ctx);
    check('summary: a re-run with the same answer stages no update for those nodes', !again.graph.updates.some((x) => ['a1', 'a2', 'a3'].includes(x.id)) && /already held these values/.test(r2.summary));
}
{
    // 150 addresses on one network: two requests, 100 and 50.
    const nodes = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`x${i}`, addr(`x${i}`, 'bitcoin', p2pkh(i + 1))]));
    const t = ctxFor({ nodes, respond: () => ok200({ set: {}, addresses: [] }) });
    const r = await P.address_summary.run(t.ctx);
    const sizes = t.net.calls.map((c) => pathOf(c).split('/').pop().split(',').length);
    check('summary: 150 addresses → requests of 100 and 50', sizes.join() === '100,50');
    check('summary: an empty `addresses` written as [] (PHP) reads as no entries', r.counts.unused === 150);
}

// ================================================================ errors
{
    const t = ctxFor({ nodes: { a1: addr('a1', 'bitcoin', GENESIS) }, respond: () => ({ status: 402, text: fixture('measured-402-invalid-key.json') }) });
    const r = await run(P.address_summary, t);
    check('402 "Invalid API token" (measured) → the run fails naming the key, nothing written', r.error && /does not accept this API key/.test(r.error.message) && /Invalid API token/.test(r.error.message) && t.graph.updates.length === 0);
}
{
    const t = ctxFor({ nodes: { a1: addr('a1', 'bitcoin', GENESIS) }, respond: () => ({ status: 430, text: fixture('measured-430-ip-blocked.json') }) });
    const r = await run(P.address_summary, t);
    check('430 (measured) → the run fails: IP blocked, check the key', r.error && /blocked requests from this IP address \(HTTP 430/.test(r.error.message) && /check the key/.test(r.error.message));
}
{
    // The first network answers; the second says the quota is spent. What was found is kept.
    const nodes = { a1: addr('a1', 'bitcoin', GENESIS), c1: addr('c1', 'bitcoin_cash', GENESIS_BCH) };
    const t = ctxFor({
        nodes,
        respond: (u) => (decodeURIComponent(u.pathname).startsWith('/bitcoin/') ? { status: 200, body: docsMulti } : { status: 402, body: { data: null, context: { code: 402, error: 'Daily request limit exceeded' } } }),
    });
    const r = await run(P.address_summary, t);
    check('402 for the plan after some answers → returns, keeps them, says STOPPED and when the counter resets', !r.error && t.graph.updates.some((x) => x.id === 'a1') && /STOPPED: Blockchair refused the request for the key's plan/.test(r.summary) && /00:00 UTC/.test(r.summary));
}
{
    let n = 0;
    const t = ctxFor({ nodes: { a1: addr('a1', 'bitcoin', GENESIS) }, respond: () => (n++ === 0 ? { status: 429, headers: { 'retry-after': '0.01' }, body: { data: null, context: { code: 429 } } } : { status: 200, body: docsMulti }) });
    const r = await run(P.address_summary, t);
    check('429 → waits (Retry-After) and retries', !r.error && t.net.calls.length === 2 && t.graph.updates.length === 1);
}
{
    // A 400 whose message echoes the request URL, key and all, and a transport error that does too.
    const nodes = { a1: addr('a1', 'bitcoin', GENESIS), c1: addr('c1', 'bitcoin_cash', GENESIS_BCH) };
    const t = ctxFor({
        nodes,
        respond: (u) =>
            decodeURIComponent(u.pathname).startsWith('/bitcoin/')
                ? { status: 400, body: { data: null, context: { code: 400, error: `Bad request for token ${KEY}: https://api.blockchair.com${u.pathname}?key=${KEY}` } } }
                : new Error(`network egress denied: GET ${u.href}`),
    });
    const r = await run(P.address_summary, t);
    check('a failed request is counted, not fatal', !r.error && r.counts.failed === 2);
    check('the key is in no summary or log line, even when an error message carried the URL', !r.summary.includes(KEY) && !t.logs.join('\n').includes(KEY) && t.logs.some((l) => /<key>/.test(l)));
}

{
    // One address of a 100-address request is refused (HTTP 400). It used to fail the whole request,
    // logging the 99 valid addresses with it; halves now find it. Whether Blockchair refuses the
    // formats newer than its docs (P2SH32 CashAddr, SegWit v2–16) is not known without a key.
    const list = Array.from({ length: 100 }, (_, i) => p2pkh(0x7000 + i));
    const BAD = list[37];
    const nodes = Object.fromEntries(list.map((a, i) => [`b${i}`, addr(`b${i}`, 'bitcoin', a)]));
    const used = { balance: 1, received: 1, spent: 0, output_count: 1, first_seen_receiving: '2020-01-01 00:00:00', last_seen_receiving: '2020-01-01 00:00:00' };
    const refuse = { status: 400, body: { data: null, context: { code: 400, error: 'Invalid address' } } };
    const respond = (u) => {
        const asked = decodeURIComponent(u.pathname).split('/').pop().split(',');
        return asked.includes(BAD) ? refuse : ok200({ set: {}, addresses: Object.fromEntries(asked.map((a) => [a, used])) });
    };
    const t = ctxFor({ nodes, respond });
    const r = await run(P.address_summary, t);
    check(`summary 400: one refused address fails alone, the other 99 are looked up (${t.net.calls.length} requests)`, !r.error && r.counts.failed === 1 && r.counts.seen === 99 && t.net.calls.length <= 15);
    check('summary 400: …and only the refused address is logged', t.logs.length === 1 && t.logs[0].startsWith('b37:'));
    // A 400 on every request is not one bad address: splitting stops at its cap, 33 requests for a
    // batch of 100 rather than the 199 it takes to reach every single address.
    const all = ctxFor({ nodes, respond: () => refuse });
    const r2 = await run(P.address_summary, all);
    check('summary 400: a 400 on every request stops splitting at the cap', !r2.error && r2.counts.failed === 100 && all.net.calls.length === 33);
}
{
    // Five networks at 150 s a request: 12.5 minutes. No new batch after 7 minutes, so the run
    // returns with three networks looked up and the other two counted.
    const nodes = {
        a: addr('a', 'bitcoin', p2pkh(0x61)),
        b: addr('b', 'litecoin', p2pkh(0x62, 48)),
        c: addr('c', 'dogecoin', p2pkh(0x63, 30)),
        d: addr('d', 'dash', p2pkh(0x64, 76)),
        e: addr('e', 'bitcoin_sv', p2pkh(0x65)),
    };
    await withClock(async (clock) => {
        const t = ctxFor({
            nodes,
            respond: () => {
                clock.tick(150_000);
                return ok200({ set: {}, addresses: [] });
            },
        });
        const r = await run(P.address_summary, t);
        check(`summary time: returns inside the host's limit (${Math.round(clock.elapsed() / 1000)}s), the rest counted`, !r.error && clock.elapsed() < HOST_LIMIT_MS && r.counts.unused === 3 && /STOPPED: the run reached its time budget.*2 address\(es\) were not looked up/.test(r.summary));
    });
    // A wait for a rate limit that would end past 9 minutes is not begun: here the run had nothing
    // yet, so it fails naming the cause instead of being killed by the host a minute later.
    await withClock(async (clock) => {
        const t = ctxFor({
            nodes: { a: nodes.a },
            respond: () => {
                clock.tick(500_000);
                return { status: 429, headers: { 'retry-after': '50' }, body: { data: null, context: { code: 429 } } };
            },
        });
        const r = await run(P.address_summary, t);
        check(`summary time: no rate-limit wait past 9 minutes (${Math.round(clock.elapsed() / 1000)}s)`, r.error && /time budget/.test(r.error.message) && clock.elapsed() < HOST_LIMIT_MS && t.net.calls.length === 1);
    });
}

// ================================================================ a 404 or a missing `data` is never a negative
// Blockchair's docs: 404 is "no results" on some endpoints (deprecated) AND what a route it does not
// serve answers; a proxy in front may answer 404 with HTML. Read as "no results", each of these used
// to write a zero balance and "never used" onto the genesis address (68 BTC in the docs fixture).
{
    const bodies = {
        'a 404 naming an error': { status: 404, body: { data: null, context: { code: 404, error: 'Endpoint not found' } } },
        'a 404 that is not JSON': { status: 404, text: '<html><body>404 Not Found</body></html>' },
        'a 404 with no error and no data': { status: 404, body: { data: null, context: { code: 404 } } },
        'a 200 with data null': ok200(null),
        'a 200 with no addresses list': ok200({ set: {} }),
    };
    for (const [what, answer] of Object.entries(bodies)) {
        const t = ctxFor({ nodes: { a1: addr('a1', 'bitcoin', GENESIS) }, respond: () => answer });
        const r = await run(P.address_summary, t);
        check(`summary: ${what} → a failed lookup, nothing written`, !r.error && r.counts.failed === 1 && r.counts.unused === 0 && t.graph.updates.length === 0 && /1 lookup\(s\) failed/.test(r.summary) && /: 0 used, 0 never used/.test(r.summary));
    }
    for (const what of ['a 404 naming an error', 'a 404 that is not JSON', 'a 200 with data null']) {
        const t = ctxFor({ nodes: { t1: { id: 't1', type: TX, data: { network: 'bitcoin', tx_hash: TX170 } } }, respond: () => bodies[what] });
        const r = await run(P.transaction, t);
        check(`transaction: ${what} → a failed lookup, not "not on the node's network"`, !r.error && r.counts.failed === 1 && r.counts.not_found === 0 && !/real negative/.test(r.summary));
    }
    {
        // Network Check: Bitcoin SV answers 404 → "no answer for Bitcoin SV", not "never used".
        const respond = (u) => (decodeURIComponent(u.pathname).startsWith('/bitcoin-sv/') ? bodies['a 404 naming an error'] : ok200({ set: {}, addresses: [] }));
        const t = ctxFor({ nodes: { u1: addr('u1', 'unknown', GENESIS) }, respond });
        const r = await run(P.network_check, t);
        check('network check: a 404 on one network is "no answer" for it, not "never used"', !r.error && /no answer for Bitcoin SV/.test(r.summary) && !/never used on [^;]*Bitcoin SV/.test(r.summary) && /could not be checked on every network/.test(r.summary));
    }
    {
        // An entry listed with nothing ever received is unused, whether or not Blockchair lists it.
        const zero = { balance: 0, received: 0, spent: 0, output_count: 0, unspent_output_count: 0, first_seen_receiving: null, last_seen_receiving: null, first_seen_spending: null, last_seen_spending: null };
        const t = ctxFor({ nodes: { u1: addr('u1', 'unknown', GENESIS) }, respond: (u) => ok200({ set: {}, addresses: { [decodeURIComponent(u.pathname).split('/').pop()]: zero } }) });
        const r = await run(P.network_check, t);
        check('network check: an address listed with zeros on every network is not settled by activity', !r.error && t.graph.createdNodes.length === 0 && r.counts.unsettled === 1);
        const t2 = ctxFor({ nodes: { a1: addr('a1', 'bitcoin', GENESIS) }, respond: () => ok200({ set: {}, addresses: { [GENESIS]: zero } }) });
        const r2 = await run(P.address_summary, t2);
        check('summary: an address listed with zeros counts as never used', !r2.error && r2.counts.unused === 1 && t2.graph.updates[0]?.data.blockchair_output_count === 0);
    }
}

// ================================================================ Address Transactions
const docsTx = JSON.parse(fixture('docs-bitcoin-transaction.json')).data[TX170];
// SHAPED: a later spend by the same address, paying three addresses.
const shapedTx = {
    transaction: { block_id: 181, hash: SHAPED_TX, time: '2009-01-12 06:02:13', is_coinbase: false, input_count: 1, output_count: 3, input_total: 4000000000, output_total: 4000000000, fee: 0 },
    inputs: [{ index: 1, transaction_hash: TX170, value: 4000000000, recipient: SATOSHI, spending_index: 0 }],
    outputs: [
        { index: 0, value: 2500000000, recipient: HAL },
        { index: 1, value: 1000000000, recipient: UNUSED },
        { index: 2, value: 500000000, recipient: p2pkh(0xabc) },
    ],
};
const satoshiDashboard = (txs, count = 3) => ({
    [SATOSHI]: {
        address: { type: 'pubkey', balance: 0, received: 9000000000, spent: 9000000000, output_count: 2, unspent_output_count: 0, first_seen_receiving: '2009-01-09 03:54:39', last_seen_receiving: '2009-01-12 03:30:25', first_seen_spending: '2009-01-12 03:30:25', last_seen_spending: '2009-01-12 06:02:13', transaction_count: count },
        transactions: txs,
        utxo: [],
    },
});
const txListing = [
    { block_id: 181, hash: SHAPED_TX, time: '2009-01-12 06:02:13', balance_change: -4000000000 },
    { block_id: 170, hash: TX170, time: '2009-01-12 03:30:25', balance_change: -1000000000 },
];
const historyNet = (u) => {
    const p = decodeURIComponent(u.pathname);
    if (p.startsWith('/bitcoin/dashboards/address/')) return ok200(satoshiDashboard(u.searchParams.get('limit') === '0' ? [] : txListing), { request_cost: u.searchParams.get('transaction_details') ? 2 : 1 });
    if (p.startsWith('/bitcoin/dashboards/transactions/')) return ok200({ [TX170]: docsTx, [SHAPED_TX]: shapedTx }, { request_cost: 1.1 });
    return { status: 404, body: {} };
};
{
    const t = ctxFor({ nodes: { s1: addr('s1', 'bitcoin', SATOSHI) }, params: { max_transactions: 2 }, respond: historyNet });
    const r = await P.address_transactions.run(t.ctx);
    const [first, second] = t.net.calls;
    check('history: the address dashboard with transaction details, newest first, confirmed only', pathOf(first) === `/bitcoin/dashboards/address/${SATOSHI}` && first.u.searchParams.get('transaction_details') === 'true' && first.u.searchParams.get('limit') === '2,0' && first.u.searchParams.get('offset') === '0,0' && first.u.searchParams.get('state') === 'latest');
    check('history: then the listed transactions in one batch', pathOf(second) === `/bitcoin/dashboards/transactions/${SHAPED_TX},${TX170}` && t.net.calls.length === 2);
    const seed = t.graph.updates.find((x) => x.id === 's1')?.data ?? {};
    check('history: the address gets tx_count, history_examined and history_complete', seed.tx_count === 3 && seed.history_examined === 2 && seed.history_complete === false && seed.first_seen === '2009-01-09T03:54:39Z');
    const txs = t.graph.createdNodes.filter((n) => n.type === TX);
    const t170 = txs.find((n) => n.data.tx_hash === TX170);
    check('history: two transaction nodes with their block, fee and kind', txs.length === 2 && t170.data.block_height === 170 && t170.data.block_time === '2009-01-12T03:30:25Z' && t170.data.fee === '0' && t170.data.tx_kind === 'transfer' && t170.data.network === 'bitcoin' && t170.data.blockchair_not_drawn === 0);
    check('history: the selected address is not created again', !t.graph.createdNodes.some((n) => n.type === ADDRESS && n.data.address === SATOSHI));
    const e = (from, to) => t.graph.createdEdges.find((x) => x.from === from && x.to === to);
    const inp = e('s1', t170.id);
    check("history: 'input to' from the spender, with the amount and the input", inp?.label === 'input to' && inp.data.amount === '50' && inp.data.inputs[0].prev_txid === '0437cd7f8525ceed2324359c2d0ba26006d92d856a9c20fa0241106ee5a597c9' && inp.data.inputs[0].index === 0);
    const hal = t.graph.createdNodes.find((n) => n.data.address === HAL);
    check("history: 'output to' the payee and back to the spender (change)", e(t170.id, hal.id)?.data.amount === '10' && e(t170.id, 's1')?.label === 'output to' && e(t170.id, 's1').data.amount === '40');
    check('history: a counterparty is written with its identity only', JSON.stringify(Object.keys(hal.data).sort()) === '["address","network"]');
    check('history: a counterparty met twice is one node', t.graph.createdNodes.filter((n) => n.data.address === HAL).length === 1);
    check('history: says what it did, and that the history is partial', /1 of 1 address\(es\) read on Blockchair, 2 transaction\(s\) drawn/.test(r.summary) && /history_complete false/.test(r.summary) && /3\.1 Blockchair request point\(s\) used/.test(r.summary));
}
{
    const t = ctxFor({ nodes: { s1: addr('s1', 'bitcoin', SATOSHI) }, params: { max_transactions: 2, start: 'oldest' }, respond: historyNet });
    await P.address_transactions.run(t.ctx);
    const [head, page] = t.net.calls;
    check('history oldest: a count first, then the page that ends at the oldest', head.u.searchParams.get('limit') === '0' && !head.u.searchParams.get('transaction_details') && page.u.searchParams.get('offset') === '1,0' && page.u.searchParams.get('limit') === '2,0');
}
{
    const t = ctxFor({ nodes: { s1: addr('s1', 'bitcoin', SATOSHI) }, params: { max_transactions: 2, max_counterparties: 1 }, respond: historyNet });
    const r = await P.address_transactions.run(t.ctx);
    const shaped = t.graph.createdNodes.find((n) => n.data.tx_hash === SHAPED_TX);
    const outs = t.graph.createdEdges.filter((x) => x.from === shaped.id);
    check('history cap: the largest counterparty is drawn, the rest counted on the node', outs.length === 1 && t.graph.createdNodes.find((n) => n.id === outs[0].to).data.address === HAL && shaped.data.blockchair_not_drawn === 2 && /2 counterparty address\(es\) past Counterparties per side/.test(r.summary));
}
{
    // Links that already exist, as an older app listed them (no data): one under the label this pack
    // writes is left alone and counted; one under another label keeps it and gets the amounts.
    const t0 = ctxFor({ nodes: { s1: addr('s1', 'bitcoin', SATOSHI) }, params: { max_transactions: 2 }, respond: historyNet });
    await P.address_transactions.run(t0.ctx);
    const t170 = t0.graph.createdNodes.find((n) => n.data.tx_hash === TX170);
    const sameIn = t0.graph.createdEdges.find((x) => x.from === 's1' && x.to === t170.id);
    const nodes = () => ({ s1: addr('s1', 'bitcoin', SATOSHI), tx: { id: 'tx', type: TX, data: { network: 'bitcoin', tx_hash: TX170 } } });
    const edges = [
        { id: 'e1', from_node_id: 's1', to_node_id: 'tx', label: 'input to', data: sameIn.data },
        { id: 'e2', from_node_id: 'tx', to_node_id: 's1', label: 'change back to', data: {} },
    ];
    const t = ctxFor({ nodes: nodes(), edges, edgeData: false, params: { max_transactions: 2 }, respond: historyNet });
    const r = await P.address_transactions.run(t.ctx);
    check('history: an existing same-label link whose data an older app does not show is left alone', !t.graph.createdEdges.some((x) => x.from === 's1' && x.to === 'tx') && !t.graph.edgeUpdates.some((x) => x.id === 'e1'));
    const up = t.graph.edgeUpdates.find((x) => x.id === 'e2');
    check("history: an existing link under another label keeps it and gets this pack's data", up && !('label' in up.patch) && up.patch.data.amount === '40' && !t.graph.createdEdges.some((x) => x.from === 'tx' && x.to === 's1'));
    check('history: says it amended one link and left one as it was', /1 existing link\(s\) given amounts/.test(r.summary) && /1 link\(s\) already drawn with the same label left as they were/.test(r.summary));
    check("history: …and says why without blaming the app as it is now", /their data was not passed to this run \(an older Vineyard does not pass a link's data to plugins\)/.test(r.summary) && !/a plugin cannot read a link's data/.test(r.summary));

    // The app as it is now passes edge data: the same data is not written, different data is.
    const known = ctxFor({ nodes: nodes(), edges, params: { max_transactions: 2 }, respond: historyNet });
    const rk = await P.address_transactions.run(known.ctx);
    check('history: with edge data shown, a link with the same data is not written', !known.graph.edgeUpdates.some((x) => x.id === 'e1') && !/left as they were/.test(rk.summary));
    const stale = ctxFor({ nodes: nodes(), edges: [{ ...edges[0], data: { ...sameIn.data, amount: '49' } }], params: { max_transactions: 2 }, respond: historyNet });
    const rs = await P.address_transactions.run(stale.ctx);
    check('history: with edge data shown, a same-label link with other data is given the amounts', stale.graph.edgeUpdates.find((x) => x.id === 'e1')?.patch.data.amount === '50' && /1 existing link\(s\) given amounts/.test(rs.summary));
    // A same-label link someone else drew without amounts gets them on a re-run.
    const bare = ctxFor({ nodes: nodes(), edges: [{ ...edges[0], data: {} }], params: { max_transactions: 2 }, respond: historyNet });
    await P.address_transactions.run(bare.ctx);
    const ub = bare.graph.edgeUpdates.find((x) => x.id === 'e1');
    check('history: with edge data shown, a same-label link without amounts is given them, label untouched', ub?.patch.data.amount === '50' && Array.isArray(ub.patch.data.inputs) && !('label' in ub.patch));
}
{
    // A re-run over what the first run drew, with the graph as the host shows it, stages no link:
    // on the app as it is now because the data is compared, on an older one because it is not read.
    const t0 = ctxFor({ nodes: { s1: addr('s1', 'bitcoin', SATOSHI) }, params: { max_transactions: 2 }, respond: historyNet });
    await P.address_transactions.run(t0.ctx);
    const s1 = await t0.graph.get('s1');
    const after = { s1: { ...s1, data: { ...s1.data } } };
    for (const n of t0.graph.createdNodes) after[n.id] = { ...n, data: { ...n.data } };
    const drawn = t0.graph.createdEdges.map((e, i) => ({ id: `d${i}`, from_node_id: e.from, to_node_id: e.to, label: e.label, data: e.data }));
    const t = ctxFor({ nodes: after, selection: ['s1'], edges: drawn, params: { max_transactions: 2 }, respond: historyNet });
    const r = await P.address_transactions.run(t.ctx);
    check(`history: a re-run creates and restates no link (${drawn.length} drawn before)`, drawn.length >= 5 && t.graph.createdEdges.length === 0 && t.graph.edgeUpdates.length === 0 && t.graph.createdNodes.length === 0);
    check('history: …and has nothing to say about links it could not read', !/already drawn with the same label/.test(r.summary) && !/new link/.test(r.summary));
    const old = ctxFor({ nodes: after, selection: ['s1'], edges: drawn, edgeData: false, params: { max_transactions: 2 }, respond: historyNet });
    const ro = await P.address_transactions.run(old.ctx);
    check(`history: on an older app a re-run creates and restates no link either`, old.graph.createdEdges.length === 0 && old.graph.edgeUpdates.length === 0);
    check('history: …and says the links were left as they were', new RegExp(`${drawn.length} link\\(s\\) already drawn with the same label`).test(ro.summary) && !/new link/.test(ro.summary));
}
{
    // Counterparties per side = 1 over two transactions that share a counterparty: the one drawn for
    // the first transaction is not "selected" in the second.
    const B = p2pkh(0xb1);
    const C = p2pkh(0xc1);
    const D = p2pkh(0xd1);
    const TXA = 'a1'.repeat(32);
    const TXB = 'b2'.repeat(32);
    const spend = (hash, block, outs) => ({
        transaction: { block_id: block, hash, time: '2010-01-01 00:00:00', is_coinbase: false, input_count: 1, output_count: outs.length, input_total: 1000, output_total: 1000, fee: 0 },
        inputs: [{ index: 0, transaction_hash: TX170, value: 1000, recipient: SATOSHI, spending_index: 0 }],
        outputs: outs.map(([recipient, value], index) => ({ index, value, recipient })),
    });
    const respond = (u) => {
        const p = decodeURIComponent(u.pathname);
        if (p.startsWith('/bitcoin/dashboards/address/')) return ok200(satoshiDashboard([{ block_id: 2, hash: TXA, time: '2010-01-01 00:00:00', balance_change: -1 }, { block_id: 1, hash: TXB, time: '2010-01-01 00:00:00', balance_change: -1 }], 2));
        if (p.startsWith('/bitcoin/dashboards/transactions/')) return ok200({ [TXA]: spend(TXA, 2, [[B, 900], [C, 50]]), [TXB]: spend(TXB, 1, [[D, 900], [B, 50]]) });
        return { status: 404, body: { data: null, context: { code: 404, error: 'unexpected' } } };
    };
    const t = ctxFor({ nodes: { s1: addr('s1', 'bitcoin', SATOSHI) }, params: { max_transactions: 2, max_counterparties: 1 }, respond });
    await P.address_transactions.run(t.ctx);
    const node = (h) => t.graph.createdNodes.find((n) => n.data.tx_hash === h);
    const outsOf = (h) => t.graph.createdEdges.filter((x) => x.from === node(h).id).map((x) => t.graph.createdNodes.find((n) => n.id === x.to)?.data.address);
    check('history cap: a counterparty drawn for one transaction does not bypass the cap in the next', outsOf(TXA).join() === B && outsOf(TXB).join() === D && node(TXB).data.blockchair_not_drawn === 1);
}
{
    // A Bitcoin Cash seed written in the legacy form; Blockchair lists the CashAddr.
    const respond = (u) => {
        const p = decodeURIComponent(u.pathname);
        if (p.startsWith('/bitcoin-cash/dashboards/address/')) return ok200({ [GENESIS_BCH]: { address: { balance: 1, transaction_count: 1 }, transactions: [{ block_id: 600000, hash: SHAPED_TX, time: '2019-10-01 00:00:00', balance_change: 1 }] } });
        if (p.startsWith('/bitcoin-cash/dashboards/transactions/')) {
            return ok200({ [SHAPED_TX]: { ...shapedTx, transaction: { ...shapedTx.transaction, block_id: 600000 }, outputs: [{ index: 0, value: 1, recipient: GENESIS_BCH }] } });
        }
        return { status: 404, body: {} };
    };
    const t = ctxFor({ nodes: { c1: addr('c1', 'bitcoin_cash', GENESIS) }, respond });
    await P.address_transactions.run(t.ctx);
    check('history: a legacy BCH seed is asked as CashAddr', pathOf(t.net.calls[0]).endsWith(`/${GENESIS_BCH}`));
    const txNode = t.graph.createdNodes.find((n) => n.type === TX);
    check('history: the CashAddr in the transaction links to the legacy-spelled seed, no second node', t.graph.createdEdges.some((x) => x.from === txNode.id && x.to === 'c1') && !t.graph.createdNodes.some((n) => n.type === ADDRESS && n.data.address === GENESIS_BCH));
    const spender = t.graph.createdNodes.find((n) => n.type === ADDRESS);
    check('history: a counterparty listed in the legacy form is written as CashAddr', spender?.data.network === 'bitcoin_cash' && /^q[a-z0-9]{41}$/.test(spender.data.address));
}
{
    // The quota runs out at the transaction batch: the address is kept, the summary says STOPPED.
    const respond = (u) => (decodeURIComponent(u.pathname).includes('/transactions/') ? { status: 402, body: { data: null, context: { code: 402, error: 'Request limit exceeded' } } } : historyNet(u));
    const t = ctxFor({ nodes: { s1: addr('s1', 'bitcoin', SATOSHI) }, params: { max_transactions: 2 }, respond });
    const r = await run(P.address_transactions, t);
    const s1 = t.graph.updates.find((x) => x.id === 's1')?.data ?? {};
    // The stop came at the last request, so nothing is left unreached: the line names the cause, and
    // the address is named by the one that says to run it again.
    check('history: a stop at the transactions keeps the address update and says STOPPED', !r.error && s1.balance === '0' && /STOPPED: Blockchair refused the request for the key's plan/.test(r.summary) && !/were not looked up/.test(r.summary));
    check('history: …but claims no history it did not draw', !('history_examined' in s1) && !('history_complete' in s1) && /1 address\(es\) were read but not all of their transactions were drawn/.test(r.summary));
}
{
    // Two addresses; the second hits the quota. The first was read, but its transactions were never
    // drawn: it must not say its history is complete, and the summary must say to run it again.
    const OTHER = p2pkh(0x0e);
    const respond = (u) => {
        const p = decodeURIComponent(u.pathname);
        if (p === `/bitcoin/dashboards/address/${OTHER}`) return { status: 402, body: { data: null, context: { code: 402, error: 'API key limit exceeded' } } };
        if (p.startsWith('/bitcoin/dashboards/address/')) return ok200(satoshiDashboard(txListing, 2));
        return historyNet(u);
    };
    const t = ctxFor({ nodes: { s1: addr('s1', 'bitcoin', SATOSHI), s2: addr('s2', 'bitcoin', OTHER) }, params: { max_transactions: 2 }, respond });
    const r = await run(P.address_transactions, t);
    const s1 = t.graph.updates.find((x) => x.id === 's1')?.data ?? {};
    check('history: a stop after the first address keeps its summary fields', !r.error && s1.balance === '0' && s1.tx_count === 2);
    check('history: …without history_complete or history_examined, since nothing was drawn', !('history_complete' in s1) && !('history_examined' in s1) && t.graph.createdNodes.length === 0);
    check('history: …and the summary names both the address not reached and the one to run again', /STOPPED: .*1 address\(es\) were not looked up/.test(r.summary) && /1 address\(es\) were read but not all of their transactions were drawn/.test(r.summary));
}
{
    // A complete history, all drawn: history_complete true, history_examined the count.
    const respond = (u) => (decodeURIComponent(u.pathname).startsWith('/bitcoin/dashboards/address/') ? ok200(satoshiDashboard(txListing, 2)) : historyNet(u));
    const t = ctxFor({ nodes: { s1: addr('s1', 'bitcoin', SATOSHI) }, params: { max_transactions: 5 }, respond });
    await run(P.address_transactions, t);
    const s1 = t.graph.updates.find((x) => x.id === 's1')?.data ?? {};
    check('history: every transaction read and drawn → history_complete true', s1.history_complete === true && s1.history_examined === 2);
    // One of the two is missing from the batch answer: not drawn, so no history claim.
    const t2 = ctxFor({
        nodes: { s1: addr('s1', 'bitcoin', SATOSHI) },
        params: { max_transactions: 5 },
        respond: (u) => (decodeURIComponent(u.pathname).startsWith('/bitcoin/dashboards/transactions/') ? ok200({ [TX170]: docsTx }) : respond(u)),
    });
    const r2 = await run(P.address_transactions, t2);
    const s1b = t2.graph.updates.find((x) => x.id === 's1')?.data ?? {};
    check('history: a transaction that could not be read → no history claim', !('history_complete' in s1b) && !('history_examined' in s1b) && /1 transaction\(s\) could not be read/.test(r2.summary));
}

{
    // The project's type pack refuses the writes: said in the summary, with what to do, not thrown.
    const t = ctxFor({ nodes: { s1: addr('s1', 'bitcoin', SATOSHI) }, params: { max_transactions: 2 }, respond: historyNet });
    t.graph.updateNode = async () => {
        throw new Error('cryptocurrency.crypto_address: address_kind must be one of "eoa", "contract" — got "p2pkh"');
    };
    t.graph.createNode = async (d) => {
        throw new Error(`type "${d.type}" is not defined by any installed typepack. Call list_node_types and use one of the types it returns.`);
    };
    const r = await run(P.address_transactions, t);
    check('history: a refused update and a type the project lacks are named with the fix, not thrown', !r.error && /refused by the project \(update the Cryptocurrency type pack/.test(r.summary) && /STOPPED drawing: install the Cryptocurrency type pack/.test(r.summary));
    const t2 = ctxFor({ nodes: { a1: addr('a1', 'bitcoin', GENESIS) }, respond: () => ({ status: 200, body: docsMulti }) });
    t2.graph.updateNode = t.graph.updateNode;
    const r2 = await run(P.address_summary, t2);
    check('summary: a refused update is counted with the fix', !r2.error && r2.counts.refused === 1 && /update the Cryptocurrency type pack/.test(r2.summary) && !/already held/.test(r2.summary));
}

// ---- time budget, stops across networks, blockchair_not_drawn ---------------------------------
{
    // 60 addresses × 25 transactions at 3 s a request: 210 requests and 10.5 minutes, past the
    // host's 10, which failed the task and threw away everything it had staged while the points
    // stayed spent (review, 2026-11-15). The run must return inside the limit with what it drew.
    // 25 is not a multiple of ten, so the last address read leaves hashes short of a request's worth:
    // they are still drawn.
    const N = 60;
    const T = 25;
    const nodes = {};
    for (let i = 0; i < N; i++) nodes[`h${i}`] = addr(`h${i}`, 'bitcoin', p2pkh(0x5000 + i));
    await withClock(async (clock) => {
        const sent = [];
        const addressAsked = [];
        const respond = (u) => {
            sent.push(clock.elapsed());
            clock.tick(3000);
            const p = decodeURIComponent(u.pathname);
            if (p.startsWith('/bitcoin/dashboards/address/')) {
                addressAsked.push(sent[sent.length - 1]);
                const a = p.split('/').pop();
                const txs = Array.from({ length: T }, (_, j) => ({ block_id: 1, hash: hashOf(a, j), time: '2020-01-01 00:00:00', balance_change: 1 }));
                return ok200({ [a]: { address: { balance: 1, received: 1, spent: 0, output_count: T, transaction_count: T, first_seen_receiving: '2020-01-01 00:00:00', last_seen_receiving: '2020-01-02 00:00:00' }, transactions: txs } });
            }
            const hs = p.split('/').pop().split(',');
            return ok200(Object.fromEntries(hs.map((h) => [h, bareTx(h)])), { request_cost: 1.9 });
        };
        const t = ctxFor({ nodes, params: { max_transactions: T }, respond });
        const r = await run(P.address_transactions, t);
        const doneAt = clock.elapsed();
        check(`history time: a run that would take 10.5 minutes returns inside the host's 10 (${Math.round(doneAt / 1000)}s)`, !r.error && doneAt < HOST_LIMIT_MS);
        check('history time: no request is sent past 9 minutes, and no address is read past 7', sent.length > 0 && Math.max(...sent) <= 9 * 60_000 && Math.max(...addressAsked) <= 7 * 60_000);
        const complete = t.graph.updates.filter((x) => x.data.history_examined === T).map((x) => x.id);
        const touched = new Set(t.graph.updates.filter((x) => x.id in nodes).map((x) => x.id));
        const notReached = Number(/(\d+) address\(es\) were not looked up/.exec(r.summary ?? '')?.[1]);
        check(
            'history time: it says STOPPED for the time budget and counts the addresses not reached',
            /STOPPED: the run reached its time budget/.test(r.summary ?? '') && notReached > 0 && complete.length + notReached === N,
        );
        check('history time: the addresses reached are drawn in full, the rest not asked about', complete.length > 0 && touched.size === complete.length && t.graph.createdNodes.length === complete.length * T);
    });
}
{
    // One Bitcoin and one Litecoin address, two transactions each; the quota runs out at the Bitcoin
    // transactions. A STOPPED count of the stopped network's transactions left Litecoin's out; the
    // addresses are what the analyst runs again, so they are what is counted — both of them.
    const LTC = p2pkh(0x4444, 0x30);
    const ltcTx = [hashOf('ltc', 1), hashOf('ltc', 2)];
    const respond = (u) => {
        const p = decodeURIComponent(u.pathname);
        if (p.startsWith('/bitcoin/dashboards/address/')) return ok200(satoshiDashboard(txListing, 2));
        if (p.startsWith('/bitcoin/dashboards/transactions/')) return quota402;
        if (p.startsWith('/litecoin/dashboards/address/')) return ok200({ [LTC]: { address: { balance: 1, transaction_count: 2 }, transactions: ltcTx.map((hash) => ({ block_id: 1, hash, time: '2020-01-01 00:00:00', balance_change: 1 })) } });
        if (p.startsWith('/litecoin/dashboards/transactions/')) return ok200(Object.fromEntries(ltcTx.map((h) => [h, bareTx(h)])));
        return { status: 404, body: {} };
    };
    const t = ctxFor({ nodes: { s1: addr('s1', 'bitcoin', SATOSHI), l1: addr('l1', 'litecoin', LTC) }, params: { max_transactions: 2 }, respond });
    const r = await run(P.address_transactions, t);
    check(
        'history stop: a stop on one network counts every address left to run again, on all of them',
        !r.error && /2 address\(es\) were read but not all of their transactions were drawn/.test(r.summary) && !/transaction\(s\) were not looked up/.test(r.summary) && /STOPPED: Blockchair refused/.test(r.summary),
    );
}
{
    // T has 30 outputs and an earlier run drew them all: blockchair_not_drawn 0, its links on the
    // graph. Address Transactions at its default cap of 25 must not raise the count to 5.
    const outs = Array.from({ length: 30 }, (_, i) => p2pkh(0x9000 + i));
    const TXF = 'f1'.repeat(32);
    const entry = {
        transaction: { block_id: 5, hash: TXF, time: '2011-01-01 00:00:00', is_coinbase: false, input_count: 1, output_count: 30, input_total: 3000, output_total: 3000, fee: 0 },
        inputs: [{ index: 0, transaction_hash: TX170, value: 3000, recipient: SATOSHI, spending_index: 0 }],
        outputs: outs.map((recipient, index) => ({ index, value: 100, recipient })),
    };
    const respond = (u) => {
        const p = decodeURIComponent(u.pathname);
        if (p.startsWith('/bitcoin/dashboards/address/')) return ok200(satoshiDashboard([{ block_id: 5, hash: TXF, time: '2011-01-01 00:00:00', balance_change: -3000 }], 1));
        if (p.startsWith('/bitcoin/dashboards/transactions/')) return ok200({ [TXF]: entry });
        return { status: 404, body: {} };
    };
    const live = (count) => ({ s1: addr('s1', 'bitcoin', SATOSHI), tx: { id: 'tx', type: TX, data: { network: 'bitcoin', tx_hash: TXF, blockchair_not_drawn: count } } });
    const lower = ctxFor({ nodes: live(0), selection: ['s1'], respond });
    const r = await run(P.address_transactions, lower);
    check('not_drawn: a run with a smaller cap leaves a lower count standing', !r.error && (await lower.graph.get('tx')).data.blockchair_not_drawn === 0 && /5 counterparty address\(es\) past Counterparties per side/.test(r.summary));
    const higher = ctxFor({ nodes: live(5), selection: ['s1'], params: { max_counterparties: 50 }, respond });
    await run(P.address_transactions, higher);
    check('not_drawn: a run that draws more writes the lower count', (await higher.graph.get('tx')).data.blockchair_not_drawn === 0);
    const fresh = ctxFor({ nodes: { s1: addr('s1', 'bitcoin', SATOSHI) }, respond });
    await run(P.address_transactions, fresh);
    check('not_drawn: a new transaction gets its count', fresh.graph.createdNodes.find((n) => n.data.tx_hash === TXF)?.data.blockchair_not_drawn === 5);
    // Blockchair Transaction on the selected node, with a cap of 10: the 0 stays.
    const sel = ctxFor({ nodes: live(0), selection: ['tx'], params: { max_counterparties: 10 }, respond });
    await run(P.transaction, sel);
    check('not_drawn: Blockchair Transaction with a smaller cap does not raise it either', sel.graph.updates.some((x) => x.id === 'tx') && !sel.graph.updates.some((x) => x.id === 'tx' && 'blockchair_not_drawn' in x.data));
}

// ================================================================ Transaction
{
    const nodes = {
        t1: { id: 't1', type: TX, data: { network: 'bitcoin', tx_hash: `0x${TX170.toUpperCase()}` } },
        t2: { id: 't2', type: TX, data: { network: 'bitcoin_cash', tx_hash: SHAPED_TX } },
        t3: { id: 't3', type: TX, data: { network: 'ethereum', tx_hash: SHAPED_TX } },
    };
    const respond = (u) => {
        const p = decodeURIComponent(u.pathname);
        if (p === `/bitcoin/dashboards/transactions/${TX170}`) return ok200({ [TX170]: docsTx });
        if (p.startsWith('/bitcoin-cash/dashboards/transactions/')) return ok200([]); // not found: no key for it
        return { status: 404, body: {} };
    };
    const t = ctxFor({ nodes, respond });
    const r = await P.transaction.run(t.ctx);
    check('transaction: a 0x-prefixed upper-case hash is asked bare and lower case', t.net.calls.some((c) => pathOf(c) === `/bitcoin/dashboards/transactions/${TX170}`));
    const u = t.graph.updates.find((x) => x.id === 't1')?.data ?? {};
    check('transaction: the selected node gets its block, fee and counts, its identity untouched', u.block_height === 170 && u.fee === '0' && u.blockchair_output_count === 2 && u.blockchair_not_drawn === 0 && !('tx_hash' in u) && !('network' in u));
    check('transaction: no second node for the selected transaction', !t.graph.createdNodes.some((n) => n.type === TX));
    check("transaction: the addresses on each side are linked to the selected node", t.graph.createdEdges.filter((x) => x.to === 't1').length === 1 && t.graph.createdEdges.filter((x) => x.from === 't1').length === 2);
    check('transaction: one not on its network is a real negative, named', r.counts.not_found === 1 && /not on the node's network per Blockchair/.test(r.summary) && !t.graph.updates.some((x) => x.id === 't2'));
    check('transaction: another chain is skipped and named', /ethereum 1/.test(r.summary));
}

{
    // 300 selected transactions at 25 s a request: 30 requests and 12.5 minutes. The run must stop
    // between batches inside the host's limit, keep what it drew, and count what it did not reach.
    const nodes = {};
    for (let i = 0; i < 300; i++) nodes[`x${i}`] = { id: `x${i}`, type: TX, data: { network: 'bitcoin', tx_hash: hashOf('sel', i) } };
    await withClock(async (clock) => {
        const sent = [];
        const respond = (u) => {
            sent.push(clock.elapsed());
            clock.tick(25_000);
            const hs = decodeURIComponent(u.pathname).split('/').pop().split(',');
            return ok200(Object.fromEntries(hs.map((h) => [h, bareTx(h)])), { request_cost: 1.9 });
        };
        const t = ctxFor({ nodes, respond });
        const r = await run(P.transaction, t);
        const left = Number(/(\d+) transaction\(s\) were not looked up/.exec(r.summary ?? '')?.[1]);
        check(`transaction time: a 12-minute selection returns inside the host's limit (${Math.round(clock.elapsed() / 1000)}s)`, !r.error && clock.elapsed() < HOST_LIMIT_MS);
        check('transaction time: no batch is sent past 7 minutes', Math.max(...sent) <= 7 * 60_000);
        check('transaction time: STOPPED for the time budget, and what was found plus what was not reached is the selection', /STOPPED: the run reached its time budget/.test(r.summary ?? '') && r.counts.found > 0 && r.counts.found + left === 300);
    });
}
{
    // Eleven Bitcoin transactions and one Litecoin one; the quota runs out at the second Bitcoin
    // request. The Litecoin transaction was never asked about and is counted with the rest.
    const nodes = {};
    for (let i = 0; i < 11; i++) nodes[`b${i}`] = { id: `b${i}`, type: TX, data: { network: 'bitcoin', tx_hash: hashOf('btc', i) } };
    nodes.l0 = { id: 'l0', type: TX, data: { network: 'litecoin', tx_hash: hashOf('ltc', 0) } };
    let btc = 0;
    const respond = (u) => {
        const p = decodeURIComponent(u.pathname);
        if (p.startsWith('/bitcoin/') && ++btc > 1) return quota402;
        return ok200(Object.fromEntries(p.split('/').pop().split(',').map((h) => [h, bareTx(h)])));
    };
    const t = ctxFor({ nodes, respond });
    const r = await run(P.transaction, t);
    check('transaction stop: the STOPPED count includes the networks after the one that stopped', !r.error && r.counts.found === 10 && /STOPPED: .*2 transaction\(s\) were not looked up/.test(r.summary) && !t.net.calls.some((c) => pathOf(c).startsWith('/litecoin/')));
}
{
    // One hash of a ten-transaction request is refused (HTTP 400): halves find it, the others are read.
    const hs = ['c1', 'c2', 'c3', 'c4'].map((x) => x.repeat(32));
    const nodes = Object.fromEntries(hs.map((h, i) => [`y${i}`, { id: `y${i}`, type: TX, data: { network: 'bitcoin', tx_hash: h } }]));
    const respond = (u) => {
        const asked = decodeURIComponent(u.pathname).split('/').pop().split(',');
        if (asked.includes(hs[2])) return { status: 400, body: { data: null, context: { code: 400, error: 'Invalid transaction hash' } } };
        return ok200(Object.fromEntries(asked.map((h) => [h, bareTx(h)])));
    };
    const t = ctxFor({ nodes, respond });
    const r = await run(P.transaction, t);
    check('transaction 400: one refused hash fails alone, the others are read', !r.error && r.counts.found === 3 && r.counts.failed === 1 && t.logs.length === 1 && t.logs[0].startsWith('y2:'));
}

// ================================================================ Network Check
{
    const BC1 = 'bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c';
    const DOGE = 'DEA5vGb2NpAwCiCp5yTE16F3DueQUVivQp';
    const nodes = {
        u1: addr('u1', 'unknown', GENESIS),
        u2: addr('u2', 'unknown', BC1),
        u3: addr('u3', 'unknown', DOGE),
        k1: addr('k1', 'bitcoin', SATOSHI),
    };
    const respond = (u) => {
        const p = decodeURIComponent(u.pathname);
        const asked = p.split('/').pop().split(',');
        const gen = docsMulti.data.addresses[GENESIS];
        if (p.startsWith('/bitcoin/')) return ok200({ set: {}, addresses: asked.includes(GENESIS) ? { [GENESIS]: gen } : [] });
        if (p.startsWith('/bitcoin-cash/')) return ok200({ set: {}, addresses: { [GENESIS_BCH]: { ...gen, balance: 2699999000 } } });
        return ok200({ set: {}, addresses: [] });
    };
    const t = ctxFor({ nodes, respond });
    const r = await P.network_check.run(t.ctx);
    const nets = t.net.calls.map((c) => pathOf(c).split('/')[1]).sort();
    check('network check: one request per candidate network', nets.join() === 'bitcoin,bitcoin-cash,bitcoin-sv,dogecoin');
    check('network check: the BCH candidate is asked as CashAddr', pathOf(t.net.calls.find((c) => pathOf(c).startsWith('/bitcoin-cash/'))).endsWith(`/${GENESIS_BCH}`));
    const made = t.graph.createdNodes;
    const btc = made.find((n) => n.data.network === 'bitcoin' && n.data.address === GENESIS);
    const bch = made.find((n) => n.data.network === 'bitcoin_cash');
    check('network check: a node on each network with activity, in that network’s form, with its fields', btc?.data.balance === '68.12392291' && bch?.data.address === GENESIS_BCH && bch.data.balance === '26.99999' && !made.some((n) => n.data.network === 'bitcoin_sv'));
    const same = t.graph.createdEdges.filter((e) => e.from === 'u1');
    const said = (e) => e.data.check_blockchair ?? {};
    check(
        "network check: 'same address on' from the unknown node, saying how",
        same.length === 2 && same.every((e) => e.label === 'same address on' && said(e).basis === 'activity' && /^\d{4}-\d{2}-\d{2}$/.test(said(e).as_of) && said(e).candidates.join() === 'bitcoin,bitcoin_cash,bitcoin_sv'),
    );
    // Commit merges link data by top-level key: a shared `basis` would be overwritten by the next
    // source to settle the pair (OFAC Address Screening writes one), mixing two sources' records.
    check("network check: the link's data is under this source's own key only", same.every((e) => Object.keys(e.data).join() === 'check_blockchair'));
    const fmt = t.graph.createdEdges.find((e) => e.from === 'u2');
    check('network check: a bech32 address never used is settled by its format', fmt && said(fmt).basis === 'format' && !('candidates' in said(fmt)) && made.find((n) => n.id === fmt.to)?.data.address_kind === 'p2wpkh');
    check('network check: an unused D… stays open, and Verge is named', !t.graph.createdEdges.some((e) => e.from === 'u3') && /DEA5vGb2NpAwCiCp5yTE16F3DueQUVivQp: never used on Dogecoin; it may also be verge/.test(r.summary));
    check('network check: the unknown node itself is not changed, an established one is skipped', t.graph.updates.length === 0 && /1 address\(es\) already have a network/.test(r.summary));
    check('network check: separate accounts that share a string are called that', /used on more than one network — separate accounts that share a string: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa on Bitcoin and Bitcoin Cash/.test(r.summary) && r.counts.settled === 2 && r.counts.unsettled === 1);
}

for (const n of fail) console.log('FAIL', n);
console.log(`\n${fail.length ? 'FAIL' : 'PASS'} ${ok.length} / ${ok.length + fail.length}`);
if (fail.length) process.exit(1);

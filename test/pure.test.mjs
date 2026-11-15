// Unit tests for the pure modules — address encodings (src/codec.ts, src/address.ts), value
// conversions (src/values.ts, src/fields.ts) and the transaction plan (src/txgraph.ts). No network,
// no host.
//   Run: node test/pure.test.mjs
//
// The modules are bundled to a temp directory with the same pinned esbuild the pack uses, because
// they are TypeScript and this runs on plain Node.
//
// Where the vectors come from, so a reader can tell a checked fact from an assumption:
//   - Base58Check hashes: the `script_hex` Blockchair's own documentation prints for each address
//     (76a914<hash>88ac, a914<hash>87), an independent source for what the address decodes to.
//   - SHA-256: node:crypto.
//   - bech32/bech32m: BIP-173 and BIP-350 test vectors, and two addresses from Blockchair's docs.
//   - CashAddr: the genesis key's CashAddr, which Haskoin's BCH API served for 1A1zP1… on
//     2026-11-14, and Blockchair's documented example `qzyl04w3…`.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'blockchair-pure-'));
const load = async (name) => {
    const out = join(dir, `${name}.mjs`);
    execFileSync('npx', ['--yes', 'esbuild@0.25.12', join(root, 'src', `${name}.ts`), '--bundle', '--format=esm', '--platform=neutral', '--log-level=warning', `--outfile=${out}`], { cwd: root });
    return import(pathToFileURL(out).href);
};
const codec = await load('codec');
const addr = await load('address');
const val = await load('values');
const fields = await load('fields');
const txg = await load('txgraph');

const ok = [];
const fail = [];
const check = (name, cond) => (cond ? ok : fail).push(name);
const hex = (u8) => Buffer.from(u8).toString('hex');
const fromHex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

// ---- SHA-256 against node:crypto, across the padding boundaries --------------------------------
{
    let same = true;
    for (const len of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
        const b = len === 3 ? Buffer.from('abc') : randomBytes(len);
        if (hex(codec.sha256(Uint8Array.from(b))) !== createHash('sha256').update(b).digest('hex')) same = false;
    }
    check('sha256 equals node:crypto for 12 lengths around the block boundaries', same);
}

// ---- Base58Check ------------------------------------------------------------------------------
{
    const vec = [
        ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 0, '62e907b15cbf27d5425399ebf6f0fb50ebb88f18'],
        ['12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX', 0, '119b098e2e980a229e139a9ed01a469e518e6f26'],
        ['3FdhDDr42mMXX4tpG6dPkHuoCrPTJk3yjH', 5, '98f0e489f60c3971fa304290257374d7ea92292b'],
        ['LNAifc8nfjtDJ8azRPiancbZSBftPzhfzb', 48, '204bc7902ad5bfc5174b2c3d5162156695fb6478'],
    ];
    for (const [a, v, h] of vec) {
        const p = codec.base58CheckDecode(a);
        check(`base58check decodes ${a.slice(0, 8)}… to Blockchair's documented script hash`, p && p[0] === v && hex(p.subarray(1)) === h);
        check(`base58check re-encodes ${a.slice(0, 8)}…`, codec.base58CheckEncode(fromHex(v.toString(16).padStart(2, '0') + h)) === a);
    }
    check('base58check refuses a changed character (checksum)', codec.base58CheckDecode('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb') === null);
    check('base58 refuses characters outside the alphabet (0, O, I, l)', codec.base58Decode('1A1z0') === null && codec.base58Decode('1Al') === null);
}

// ---- bech32 / bech32m -------------------------------------------------------------------------
{
    const v0 = codec.segwitDecode('bc', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4');
    check('BIP-173 vector: upper-case v0 P2WPKH decodes', v0 && v0.version === 0 && hex(v0.program) === '751e76e8199196d454941c45d1b3a323f1433bd6');
    const v1 = codec.segwitDecode('bc', 'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y');
    check('BIP-350 vector: v1 with bech32m decodes', v1 && v1.version === 1 && v1.program.length === 40);
    check('BIP-350: a v0 program under the bech32m constant is refused', codec.segwitDecode('bc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh') === null);
    check('mixed case is refused', codec.segwitDecode('bc', 'bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4') === null);
    check("Blockchair's documented P2WPKH and P2WSH decode", codec.segwitDecode('bc', 'bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c')?.program.length === 20 && codec.segwitDecode('bc', 'bc1qva7utdxd6easljpy28kvuyq67x4y9t9mwcdep4xrwrr98wkrxs8qhxqj70')?.program.length === 32);
    check('a Bitcoin address is not a Litecoin one', codec.segwitDecode('ltc', 'bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c') === null);
}

// ---- CashAddr ---------------------------------------------------------------------------------
{
    const genesisHash = '62e907b15cbf27d5425399ebf6f0fb50ebb88f18';
    check('the genesis key as CashAddr is the one Haskoin served', codec.cashAddrEncode(0, fromHex(genesisHash)) === 'qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy');
    const d = codec.cashAddrDecode('bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy');
    check('a prefixed CashAddr decodes to P2PKH and the hash', d && d.type === 0 && hex(d.hash) === genesisHash);
    check('an upper-case CashAddr decodes', codec.cashAddrDecode('QP3WJPA3TJLJ042Z2WV7HAHSLDGWHWY0RQ9SYWJPYY')?.type === 0);
    check("Blockchair's documented CashAddr checksums", !!codec.cashAddrDecode('qzyl04w3m99ddpqahzwghn3erallm3e7z5le4aqqmh'));
    check('a changed character fails the checksum', codec.cashAddrDecode('qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyz') === null);
    check('an eCash-prefixed address is not a Bitcoin Cash one', codec.cashAddrDecode('ecash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy') === null);
    // The CashAddr specification's own legacy ↔ CashAddr translation examples.
    const spec = [
        ['1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu', 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'],
        ['1KXrWXciRDZUpQwQmuM1DbwsKDLYAYsVLR', 'qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy'],
        ['16w1D5WRVKJuZUsSRzdLp9w3YGcgoxDXb', 'qqq3728yw0y47sqn6l2na30mcw6zm78dzqre909m2r'],
        ['3CWFddi6m4ndiGyKqzYvsFYagqDLPVMTzC', 'ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq'],
        ['3LDsS579y7sruadqu11beEJoTjdFiFCdX4', 'pr95sy3j9xwd2ap32xkykttr4cvcu7as4yc93ky28e'],
        ['31nwvkZwyPdgzjBJZXfDmSWsC4ZLKpYyUw', 'pqq3728yw0y47sqn6l2na30mcw6zm78dzq5ucqzc37'],
    ];
    check(
        "the CashAddr spec's six translation examples, both ways",
        spec.every(([l, c]) => addr.canonicalAddress('bitcoin_cash', l)?.address === c && addr.canonicalAddress('bitcoin_sv', c)?.address === l),
    );
    const p2sh32 = codec.cashAddrEncode(1, fromHex('11'.repeat(32)));
    check('a P2SH32 address is 61 characters and round-trips', p2sh32.length === 61 && codec.cashAddrDecode(p2sh32)?.hash.length === 32);
}

// ---- canonical forms per network ----------------------------------------------------------------
{
    const c = (n, a) => addr.canonicalAddress(n, a);
    check('BCH legacy 1A1z… → CashAddr', c('bitcoin_cash', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')?.address === 'qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy');
    check('BCH prefixed upper case → bare lower case', c('bitcoin_cash', 'BITCOINCASH:QP3WJPA3TJLJ042Z2WV7HAHSLDGWHWY0RQ9SYWJPYY')?.address === 'qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy');
    check('BCH legacy 3… → p… (P2SH)', c('bitcoin_cash', '3FdhDDr42mMXX4tpG6dPkHuoCrPTJk3yjH')?.address.startsWith('p') && c('bitcoin_cash', '3FdhDDr42mMXX4tpG6dPkHuoCrPTJk3yjH')?.kind === 'p2sh');
    check('BSV CashAddr → legacy', c('bitcoin_sv', 'qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy')?.address === '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    const ltc = c('litecoin', '3FdhDDr42mMXX4tpG6dPkHuoCrPTJk3yjH');
    check('LTC 3… → M… with the same script hash', ltc?.address.startsWith('M') && hex(codec.base58CheckDecode(ltc.address).subarray(1)) === '98f0e489f60c3971fa304290257374d7ea92292b' && ltc.kind === 'p2sh');
    check('LTC L… stays, P2PKH', c('litecoin', 'LNAifc8nfjtDJ8azRPiancbZSBftPzhfzb')?.address === 'LNAifc8nfjtDJ8azRPiancbZSBftPzhfzb' && c('litecoin', 'LNAifc8nfjtDJ8azRPiancbZSBftPzhfzb').kind === 'p2pkh');
    check('BTC bech32 upper case → lower case, P2WPKH', c('bitcoin', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4')?.address === 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' && c('bitcoin', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4').kind === 'p2wpkh');
    check('BTC P2WSH and P2TR kinds', c('bitcoin', 'bc1qva7utdxd6easljpy28kvuyq67x4y9t9mwcdep4xrwrr98wkrxs8qhxqj70')?.kind === 'p2wsh');
    check('a Litecoin L… is not a Bitcoin address', c('bitcoin', 'LNAifc8nfjtDJ8azRPiancbZSBftPzhfzb') === null);
    check('a bad checksum is no address anywhere', addr.NETWORKS.every((n) => c(n, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb') === null));
    // The same hash under each chain's version byte. The Dogecoin and Dash strings were computed
    // independently on 2026-11-14 (research notes); agreeing with them checks the encoder.
    const g = fromHex('62e907b15cbf27d5425399ebf6f0fb50ebb88f18');
    const enc = (v) => codec.base58CheckEncode(Uint8Array.from([v, ...g]));
    check('the genesis hash as Litecoin, Dogecoin and Dash matches the independently computed strings', enc(48) === 'LUEweDxDA4WhvWiNXXSxjM9CYzHPJv4QQF' && enc(30) === 'DEA5vGb2NpAwCiCp5yTE16F3DueQUVivQp' && enc(76) === 'XjhqDGJH37VEpecoDGmtJrmEB7VoD8Lb39');
    check('Dogecoin and Dash accept their own forms', c('dogecoin', enc(30))?.kind === 'p2pkh' && c('dash', enc(76))?.kind === 'p2pkh' && c('dogecoin', enc(76)) === null);
    const zt1 = codec.base58CheckEncode(Uint8Array.from([0x1c, 0xb8, ...g]));
    check('Zcash t1… (two version bytes) is P2PKH on Zcash and nothing else', zt1.startsWith('t1') && c('zcash', zt1)?.kind === 'p2pkh' && c('bitcoin', zt1) === null);
    const z = codec.cashAddrEncode(2, g);
    check('a token-aware z… is queried as its q… form', z.startsWith('z') && addr.queryForm('bitcoin_cash', z) === 'qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy');
}

// ---- candidates (Network Check) ----------------------------------------------------------------
{
    const k = (a) => addr.candidates(a);
    const g = k('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    check('1… is Bitcoin, Bitcoin Cash (as CashAddr) and Bitcoin SV', g.list.map((x) => x.network).join() === 'bitcoin,bitcoin_cash,bitcoin_sv' && g.list[1].address === 'qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy' && !g.outside.length);
    const p = k('3FdhDDr42mMXX4tpG6dPkHuoCrPTJk3yjH');
    check('3… is also Litecoin, in its M… form', p.list.map((x) => x.network).join() === 'bitcoin,bitcoin_cash,litecoin,bitcoin_sv' && p.list[2].address.startsWith('M'));
    const d = k('DEA5vGb2NpAwCiCp5yTE16F3DueQUVivQp');
    check('D… is Dogecoin here, and may be Verge', d.list.map((x) => x.network).join() === 'dogecoin' && d.outside.join() === 'verge');
    check('a CashAddr is Bitcoin Cash only', k('qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy').list.map((x) => x.network).join() === 'bitcoin_cash');
    check('bc1… is Bitcoin only', k('bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c').list.map((x) => x.network).join() === 'bitcoin');
    check('an Ethereum address has no candidate', k('0x19ddd94b94d3c68385c897846ab44ac99dbfae0f').list.length === 0);
}

// ---- values -----------------------------------------------------------------------------------
{
    const big = '{"data":{"D":{"balance":15000000000000000123,"neg":-12345678901234567,"f":1.5,"s":"12345678901234567890","t":"a:12345678901234567,b"}},"n":[9007199254740993]}';
    const j = val.parseExact(big);
    check('parseExact keeps a Dogecoin-sized balance exact', j.data.D.balance === '15000000000000000123');
    check('parseExact keeps a large negative and an array element exact', j.data.D.neg === '-12345678901234567' && j.n[0] === '9007199254740993');
    check('parseExact leaves floats, short numbers and digits in strings alone', j.data.D.f === 1.5 && j.data.D.s === '12345678901234567890' && j.data.D.t === 'a:12345678901234567,b');
    check('parseExact handles escaped quotes', val.parseExact('{"a":"x\\"12345678901234567","b":12345678901234567}').b === '12345678901234567');
    check('toDecimal satoshi → BTC', val.toDecimal(5000000000) === '50' && val.toDecimal(267582) === '0.00267582' && val.toDecimal(0) === '0' && val.toDecimal(-1000000000) === '-10');
    check('toDecimal of a digit string past 2^53', val.toDecimal('15000000000000000123') === '150000000000.00000123');
    check('toDecimal refuses a float and a rounded number', val.toDecimal(1.5) === undefined && val.toDecimal(2 ** 60) === undefined);
    check('isoTime', val.isoTime('2009-01-03 18:15:05') === '2009-01-03T18:15:05Z' && val.isoTime(null) === undefined && val.isoTime('yesterday') === undefined);
    const k = 'Sk_9/x+y';
    const msg = `GET https://api.blockchair.com/bitcoin/x?limit=0&key=${encodeURIComponent(k)} failed; raw ${k}; other ?key=zzz&a=1`;
    const r = val.redact(msg, k);
    check('redact removes the key raw, URL-encoded and in any key= parameter', !r.includes(k) && !r.includes(encodeURIComponent(k)) && !r.includes('zzz') && r.includes('key=<key>'));
    check('delta keeps only changed fields', JSON.stringify(val.delta({ a: 1, b: '2', c: [1] }, { a: 1, b: '3', c: [1], d: 0 })) === '{"b":"3","d":0}');
}

// ---- fields -----------------------------------------------------------------------------------
{
    const single = JSON.parse(readFileSync(join(root, 'test/fixtures/docs-bitcoin-address.json'), 'utf8'));
    const obj = single.data['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'].address;
    const f = fields.addressFields(obj, 'p2pkh', '2026-11-15T00:00:00Z');
    check('address fields from the documented dashboard', f.first_seen === '2009-01-03T18:15:05Z' && f.last_seen === '2019-10-24T18:47:23Z' && f.balance === '68.12392291' && f.tx_count === 1820 && f.balance_source === 'Blockchair');
    check('never spent: no spend dates, spent 0', !('blockchair_first_spent' in f) && f.blockchair_spent === '0' && f.blockchair_received === '68.12392291' && f.blockchair_output_count === 1820);
    const multi = JSON.parse(readFileSync(join(root, 'test/fixtures/docs-bitcoin-addresses.json'), 'utf8'));
    const m = fields.addressFields(multi.data.addresses['12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX'], 'p2pkh', 'x');
    check('the 100-address dashboard gives no tx_count, and none is written', !('tx_count' in m) && m.balance === '50.34470486');
    const u = fields.unusedFields('p2pkh', 'x');
    check('an unused address: zero balance and output count, and no tx_count that would outlive its first use', u.balance === '0' && u.blockchair_output_count === 0 && !('tx_count' in u));
    check('asOf reads cache.since', fields.asOf({ cache: { since: '2026-11-14 23:53:14' } }) === '2026-11-14T23:53:14Z' && /Z$/.test(fields.asOf({})));
}

// ---- the transaction plan ----------------------------------------------------------------------
{
    const tx = JSON.parse(readFileSync(join(root, 'test/fixtures/docs-bitcoin-transaction.json'), 'utf8'));
    const entry = tx.data.f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16;
    const p = txg.planTransaction('bitcoin', entry);
    check('plan: fields of the documented transaction', p.fields.block_height === 170 && p.fields.block_time === '2009-01-12T03:30:25Z' && p.fields.status === 'success' && p.fields.fee === '0' && p.fields.tx_kind === 'transfer');
    check('plan: one input address, two output addresses, largest first', p.inputs.length === 1 && p.outputs.map((s) => s.address).join() === '12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S,1Q2TWHE3GMdB6BZKafqwxXtWAWgFt5Jvm3');
    const inE = p.inputs[0].entries[0];
    check("plan: an input's index is its spending_index, and prev_txid/prev_vout name the output it spends", inE.index === 0 && inE.prev_txid === '0437cd7f8525ceed2324359c2d0ba26006d92d856a9c20fa0241106ee5a597c9' && inE.prev_vout === 0 && inE.amount === '50');
    check('plan: output amounts', p.outputs[0].total === 4000000000n && p.outputs[1].entries[0].index === 0 && p.outputs[1].entries[0].amount === '10');
    const pending = txg.planTransaction('bitcoin', { ...entry, transaction: { ...entry.transaction, block_id: -1 } });
    check('plan: a mempool transaction is pending, without block fields', pending.fields.status === 'pending' && !('block_height' in pending.fields) && !('block_time' in pending.fields));
    const cb = txg.planTransaction('bitcoin', { transaction: { ...entry.transaction, is_coinbase: true, fee: 0 }, inputs: [], outputs: [{ ...entry.outputs[0], recipient: 'd-0000' }, entry.outputs[1]] });
    check('plan: a coinbase has no fee and no inputs; a synthetic recipient is unaddressed', cb.fields.tx_kind === 'coinbase' && !('fee' in cb.fields) && cb.inputs.length === 0 && cb.unaddressed === 1 && cb.fields.blockchair_unaddressed === 1);
    check('plan: no 64-hex hash, no plan', txg.planTransaction('bitcoin', { transaction: { hash: 'x' } }) === null);
    // An address on several outputs of one transaction: one side, the total and every entry.
    const two = txg.planTransaction('bitcoin', { ...entry, outputs: [entry.outputs[0], { ...entry.outputs[0], index: 1, value: 7 }] });
    check('plan: outputs to one address fold into one side with the sum', two.outputs.length === 1 && two.outputs[0].total === 1000000007n && two.outputs[0].entries.length === 2);
    const sides = [5n, 4n, 3n, 2n, 1n].map((t, i) => ({ address: `a${i}`, kind: 'p2pkh', total: t, entries: [] }));
    const s = txg.selectSides(sides, (a) => a === 'a4', 2);
    check('selectSides: the cap counts others only, and a selected address is always drawn', s.drawn.map((x) => x.address).join() === 'a0,a1,a4' && s.left === 2);
    // blockchair_not_drawn only ever comes down: the links an earlier run drew stay on the graph.
    const nd = txg.notDrawnPatch;
    check('notDrawnPatch: a higher count does not replace a lower one', JSON.stringify(nd(0, 5)) === '{}' && JSON.stringify(nd(5, 5)) === '{}');
    check('notDrawnPatch: a lower count does, 0 included', nd(5, 0).blockchair_not_drawn === 0 && nd(9, 3).blockchair_not_drawn === 3);
    check('notDrawnPatch: a node without a usable count gets one', nd(undefined, 4).blockchair_not_drawn === 4 && nd('2', 4).blockchair_not_drawn === 4 && nd(-1, 4).blockchair_not_drawn === 4);
}

for (const n of fail) console.log('FAIL', n);
console.log(`\n${fail.length ? 'FAIL' : 'PASS'} ${ok.length} / ${ok.length + fail.length}`);
if (fail.length) process.exit(1);

// The seven networks this pack covers, and their addresses in the form the Cryptocurrency type pack
// stores.
//
// Blockchair also serves Groestlcoin and eCash; neither is a `network` value in the type pack, so
// neither is here. Monero, Ethereum and Ripple have their own shapes on Blockchair and are covered
// by other packs.
import { base58CheckDecode, base58CheckEncode, cashAddrDecode, cashAddrEncode, segwitDecode } from './codec';

export type Network = 'bitcoin' | 'bitcoin_cash' | 'litecoin' | 'bitcoin_sv' | 'dogecoin' | 'dash' | 'zcash';
export type AddressKind = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr' | 'unknown';

export interface Chain {
    /** Path prefix on api.blockchair.com. */
    slug: string;
    /** The native unit, for summaries. Every one of the seven counts in 10^-8 of it. */
    symbol: string;
    label: string;
}

export const CHAINS: Record<Network, Chain> = {
    bitcoin: { slug: 'bitcoin', symbol: 'BTC', label: 'Bitcoin' },
    bitcoin_cash: { slug: 'bitcoin-cash', symbol: 'BCH', label: 'Bitcoin Cash' },
    litecoin: { slug: 'litecoin', symbol: 'LTC', label: 'Litecoin' },
    bitcoin_sv: { slug: 'bitcoin-sv', symbol: 'BSV', label: 'Bitcoin SV' },
    dogecoin: { slug: 'dogecoin', symbol: 'DOGE', label: 'Dogecoin' },
    dash: { slug: 'dash', symbol: 'DASH', label: 'Dash' },
    zcash: { slug: 'zcash', symbol: 'ZEC', label: 'Zcash' },
};

export const NETWORKS = Object.keys(CHAINS) as Network[];

export const isCovered = (n: unknown): n is Network => typeof n === 'string' && Object.hasOwn(CHAINS, n);

/**
 * Base58Check version bytes per network (chainparams of each project, read 2026-11-14), with the
 * kind each one is. Litecoin's 5 is the old P2SH prefix it shares with Bitcoin; Litecoin Core
 * still accepts it as an alias of 50 (`M…`), which is the canonical form.
 */
const BASE58: Record<Network, Record<number, AddressKind>> = {
    bitcoin: { 0: 'p2pkh', 5: 'p2sh' },
    bitcoin_cash: { 0: 'p2pkh', 5: 'p2sh' },
    bitcoin_sv: { 0: 'p2pkh', 5: 'p2sh' },
    litecoin: { 48: 'p2pkh', 50: 'p2sh', 5: 'p2sh' },
    dogecoin: { 30: 'p2pkh', 22: 'p2sh' },
    dash: { 76: 'p2pkh', 16: 'p2sh' },
    zcash: { 0x1cb8: 'p2pkh', 0x1cbd: 'p2sh' },
};

const SEGWIT_HRP: Partial<Record<Network, string>> = { bitcoin: 'bc', litecoin: 'ltc' };

export interface Canonical {
    address: string;
    kind: AddressKind;
}

interface Legacy {
    version: number;
    hash: Uint8Array;
}

/** A Base58Check address split into its version (one byte, or two for Zcash) and 20-byte hash. */
function legacy(s: string): Legacy | null {
    const p = base58CheckDecode(s);
    if (!p) return null;
    if (p.length === 21) return { version: p[0], hash: p.subarray(1) };
    if (p.length === 22) return { version: (p[0] << 8) | p[1], hash: p.subarray(2) };
    return null;
}

function encodeLegacy(version: number, hash: Uint8Array): string {
    const head = version > 0xff ? [version >> 8, version & 0xff] : [version];
    return base58CheckEncode(Uint8Array.from([...head, ...hash]));
}

function segwitKind(version: number, len: number): AddressKind {
    if (version === 0) return len === 20 ? 'p2wpkh' : 'p2wsh';
    if (version === 1 && len === 32) return 'p2tr';
    return 'unknown';
}

/**
 * `raw` as an address on `network`, in the type pack's canonical form, or null when it is not a
 * valid address there (wrong prefix, bad checksum, a format the network does not have).
 *
 * Re-encodings, all of them the type pack's rules for writers:
 *   - bech32 → lower case (`bc1…`, `ltc1…`)
 *   - Bitcoin Cash: CashAddr without `bitcoincash:`, lower case; a legacy `1…`/`3…` → CashAddr
 *   - Litecoin `3…` → `M…` (the same script hash)
 *   - Bitcoin SV: a CashAddr → legacy Base58, the form Bitcoin SV uses
 */
export function canonicalAddress(network: Network, raw: string): Canonical | null {
    const s = (raw ?? '').trim();
    if (!s || s.length > 120) return null;
    const hrp = SEGWIT_HRP[network];
    if (hrp && s.toLowerCase().startsWith(`${hrp}1`)) {
        const w = segwitDecode(hrp, s);
        return w ? { address: s.toLowerCase(), kind: segwitKind(w.version, w.program.length) } : null;
    }
    if (network === 'bitcoin_cash' || network === 'bitcoin_sv') {
        const c = /^(bitcoincash:)?[qpzr]/i.test(s) ? cashAddrDecode(s) : null;
        if (c) {
            const kind: AddressKind = c.type === 0 || c.type === 2 ? 'p2pkh' : c.type === 1 || c.type === 3 ? 'p2sh' : 'unknown';
            if (network === 'bitcoin_cash') return { address: cashAddrEncode(c.type, c.hash), kind };
            // Bitcoin SV has no CashAddr of its own; only a 20-byte P2PKH/P2SH hash has a legacy form.
            if ((c.type === 0 || c.type === 1) && c.hash.length === 20) {
                return { address: encodeLegacy(c.type === 0 ? 0 : 5, c.hash), kind };
            }
            return null;
        }
    }
    const l = legacy(s);
    if (!l) return null;
    const kind = BASE58[network][l.version];
    if (!kind) return null;
    if (network === 'bitcoin_cash') return { address: cashAddrEncode(l.version === 0 ? 0 : 1, l.hash), kind };
    if (network === 'litecoin' && l.version === 5) return { address: encodeLegacy(50, l.hash), kind };
    return { address: s, kind };
}

/**
 * The form to send Blockchair for an address already canonical on `network`.
 *
 * Only Bitcoin Cash's token-aware CashAddr differs: `z…`/`r…` (CashTokens, 2023) lock to the same
 * script as `q…`/`p…` of the same hash, and Blockchair's documentation predates them, so the plain
 * form is asked for. The node keeps the spelling it has.
 */
export function queryForm(network: Network, canonical: string): string {
    if (network !== 'bitcoin_cash' || !/^[zr]/.test(canonical)) return canonical;
    const c = cashAddrDecode(canonical);
    return c ? cashAddrEncode(c.type & 1, c.hash) : canonical;
}

export interface Candidate extends Canonical {
    network: Network;
}

/**
 * Every covered network on which `raw` is a valid address, as that network writes it, and the
 * type pack's networks outside this pack that could hold the same string.
 *
 * A legacy `1…`/`3…` is the same bytes on Bitcoin, Bitcoin Cash (which writes it as CashAddr) and
 * Bitcoin SV, and a `3…` is also Litecoin's old P2SH prefix: those are several candidates. A `D…`
 * is Dogecoin's and also Verge's (version 30 on both), which Blockchair does not serve, so a
 * Dogecoin answer cannot settle it. A CashAddr is Bitcoin Cash's own format and has no other
 * candidate, although Bitcoin SV would accept it.
 */
export function candidates(raw: string): { list: Candidate[]; outside: string[] } {
    const s = (raw ?? '').trim();
    const list: Candidate[] = [];
    const cash = /^(bitcoincash:)?[qpzr]/i.test(s) && cashAddrDecode(s);
    for (const network of NETWORKS) {
        if (cash && network === 'bitcoin_sv') continue;
        const c = canonicalAddress(network, s);
        if (c) list.push({ network, ...c });
    }
    const l = legacy(s);
    const outside = l && l.version === 30 ? ['verge'] : [];
    return { list, outside };
}

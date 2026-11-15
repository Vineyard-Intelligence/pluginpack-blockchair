// Value conversions between Blockchair's answers and the type pack's fields. Pure.

/**
 * JSON.parse that keeps large integers exact, by turning each integer literal of 16 or more digits
 * into a string before parsing.
 *
 * WHY: Blockchair returns amounts as JSON numbers in the chain's smallest unit, and a JSON number
 * past 2^53 is rounded by JSON.parse before anything can see it. Bitcoin's 21 million BTC is
 * 2.1 x 10^15 satoshi and fits; Dogecoin has no supply cap — about 150 billion DOGE, 1.5 x 10^19
 * koinu — so one exchange wallet's balance does not. A rounded balance in an investigation record
 * is wrong in a way nobody would notice.
 *
 * A small scanner, not a regex over the text, so digits inside a string (a script, an error
 * message) are never touched. Fifteen digits and fewer are always exact, so they stay numbers.
 */
export function parseExact(text: string): unknown {
    let out = '';
    let i = 0;
    let last = 0;
    const n = text.length;
    while (i < n) {
        const ch = text.charCodeAt(i);
        if (ch === 0x22) {
            // a string: skip to its closing quote, honouring escapes
            i++;
            while (i < n) {
                const c = text.charCodeAt(i);
                if (c === 0x5c) i += 2;
                else if (c === 0x22) break;
                else i++;
            }
            i++;
            continue;
        }
        if (ch === 0x2d || (ch >= 0x30 && ch <= 0x39)) {
            const start = i;
            i++;
            while (i < n) {
                const c = text.charCodeAt(i);
                if ((c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x65 || c === 0x45 || c === 0x2b || c === 0x2d) i++;
                else break;
            }
            const tok = text.slice(start, i);
            if (/^-?\d{16,}$/.test(tok)) {
                out += text.slice(last, start) + '"' + tok + '"';
                last = i;
            }
            continue;
        }
        i++;
    }
    return JSON.parse(last ? out + text.slice(last) : text);
}

/**
 * An integer count of 10^-decimals units (a JSON number or a digit string from parseExact) as a
 * decimal string in the whole unit: 5000000000 → "50", 267582 → "0.00267582". Undefined for
 * anything that is not an integer, so a malformed amount is left out rather than written wrong.
 */
export function toDecimal(v: unknown, decimals = 8): string | undefined {
    let b: bigint;
    if (typeof v === 'number') {
        if (!Number.isSafeInteger(v)) return undefined;
        b = BigInt(v);
    } else if (typeof v === 'string' && /^-?\d+$/.test(v)) {
        b = BigInt(v);
    } else if (typeof v === 'bigint') {
        b = v;
    } else {
        return undefined;
    }
    const neg = b < 0n;
    if (neg) b = -b;
    const unit = 10n ** BigInt(decimals);
    const whole = (b / unit).toString();
    const frac = (b % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** An integer amount as a BigInt, or null. */
export function toBig(v: unknown): bigint | null {
    if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : null;
    if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
    return null;
}

/**
 * Blockchair's "YYYY-MM-DD hh:ii:ss" (UTC, per its docs) as ISO 8601 with Z, or undefined. The
 * docs give the conversion themselves: replace the space with T and append Z.
 */
export function isoTime(v: unknown): string | undefined {
    if (typeof v !== 'string') return undefined;
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})Z?$/.exec(v.trim());
    return m ? `${m[1]}T${m[2]}Z` : undefined;
}

export const earliest = (...xs: Array<string | undefined>): string | undefined =>
    xs.filter((x): x is string => !!x).sort()[0];
export const latest = (...xs: Array<string | undefined>): string | undefined =>
    xs.filter((x): x is string => !!x).sort().pop();

/**
 * `text` with the API key taken out, wherever it appears.
 *
 * The key travels in the query string (Blockchair has no header for it), so any message that can
 * carry a URL can carry the key: the host's own "network egress denied: GET <url>" does, and a
 * summary is stored with the run and read by the AI panel. Everything this pack says passes
 * through here.
 */
export function redact(text: string, key: string): string {
    let out = String(text ?? '');
    if (key) {
        for (const form of new Set([key, encodeURIComponent(key)])) out = out.split(form).join('<key>');
    }
    return out.replace(/([?&]key=)[^&\s"']*/gi, '$1<key>');
}

/** A vendor's message, one line and capped: it is someone else's text going into a summary. */
export function oneLine(text: unknown, max = 200): string {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Drop undefined, null and '' — the values a fill-merge would ignore anyway. */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v;
    return out as Partial<T>;
}

/**
 * The part of `patch` that differs from `current`: what is worth staging. A re-run that learned
 * nothing new then stages nothing, instead of a review row whose before and after are the same.
 */
export function delta(current: Record<string, unknown> | undefined, patch: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
        if (JSON.stringify(current?.[k]) !== JSON.stringify(v)) out[k] = v;
    }
    return out;
}

/** Request points, as Blockchair counts them (fractional: a 10-transaction call is 1.9). */
export const points = (n: number): string => (Math.round(n * 10) / 10).toString();

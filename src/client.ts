// Requests to api.blockchair.com: the key, pacing, retries, and what each status means.
import type { HostContext } from './sdk';
import { oneLine, parseExact, redact } from './values';

export const API = 'https://api.blockchair.com';

/**
 * A condition that ends the whole run — the key refused or out of quota, the IP blocked, a limit
 * that outlasted the waits. Every later request would get the same answer.
 *
 * A plugin rethrows it when nothing was found yet (a failed task that names the cause) and
 * otherwise stops and RETURNS, because the host discards what a thrown run staged and the answers
 * already in hand are worth keeping. The summary then says what was not reached.
 */
export class StopRun extends Error {}

/**
 * One request that failed without an answer worth reading. The next one may succeed. `status` is
 * the HTTP status when Blockchair answered: a 400 is what lookup.ts splits a batch on.
 */
export class ItemFailed extends Error {
    constructor(
        message: string,
        readonly status?: number,
    ) {
        super(message);
    }
}

export const abortErr = (): Error => new Error('cancelled');

/** A wait that Cancel cuts short. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortErr());
        const timer = setTimeout(done, ms);
        function done() {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }
        function onAbort() {
            clearTimeout(timer);
            reject(abortErr());
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });

/**
 * Spacing between requests. Blockchair applies a soft limit of 5 requests a second to free and
 * paid plans alike when its servers are under load, answering 435 past it (API docs, "API rate
 * limits"); 220 ms keeps a run under it whether or not it is switched on.
 */
const PACE_MS = 220;

/**
 * THE RUN'S TIME BUDGET. The host ends a plugin run at 10 minutes when the manifest names no budget
 * (worker-host.ts DEFAULT_TIMEOUT_MS), fails the task and discards everything it staged — while the
 * request points it spent stay spent. `lifecycle.timeout_ms` could raise that, but the registry's
 * plugin schema does not accept the key. Measured with a virtual clock against the bundle (review,
 * 2026-11-15): Address Transactions on 100 addresses × 100 transactions at 600 ms a request is
 * 1,100 requests and 11 minutes, so the manifest's own maximums were enough to lose a whole run.
 *
 * So a plugin takes no new address or batch once RUN_BUDGET_MS has passed (`outOfTime`), and no
 * request is sent, nor a wait begun, that would end past HARD_BUDGET_MS; either way the run stops
 * with a StopRun and returns what it has, naming what it did not reach. The minute left after the
 * hard budget is for the writes that follow the last answer.
 */
export const RUN_BUDGET_MS = 7 * 60_000;
export const HARD_BUDGET_MS = 9 * 60_000;
export const TIME_UP = 'the run reached its time budget (the app ends a plugin run at 10 minutes, keeping nothing from it)';

/** Waits on 429 and 435: Retry-After when sent, else 10 s, 20 s, 40 s — capped at a minute. */
const backoffMs = (attempt: number, retryAfterSec: number): number =>
    Math.min(60_000, Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 10_000 * 2 ** attempt);

export interface Answer {
    data: any;
    context: any;
}

/**
 * One run's connection to Blockchair. Holds the key, spaces the requests and adds up the request
 * points Blockchair says each one cost (`context.request_cost`), for the summary.
 */
export class Blockchair {
    private last = 0;
    cost = 0;
    requests = 0;
    /** When the run began, for the time budget. */
    readonly started = Date.now();

    constructor(
        private ctx: HostContext,
        readonly key: string,
    ) {}

    /** Anything this pack says, with the key taken out. */
    say(text: string): string {
        return redact(text, this.key);
    }

    /** True once the run should take no new address or batch (RUN_BUDGET_MS). */
    outOfTime(): boolean {
        return Date.now() - this.started > RUN_BUDGET_MS;
    }

    /** True when `ms` from now is past HARD_BUDGET_MS: no request, wait or new draw then. */
    pastDeadline(ms = 0): boolean {
        return Date.now() + ms - this.started > HARD_BUDGET_MS;
    }

    /** A wait (none when `ms` ≤ 0) that would not outlast the hard budget: past it, the run stops. */
    private async pause(ms: number): Promise<void> {
        const wait = Math.max(0, ms);
        if (this.pastDeadline(wait)) throw new StopRun(TIME_UP);
        if (wait > 0) await sleep(wait, this.ctx.signal);
    }

    /**
     * GET `path` with `query` and the key. Resolves with the decoded answer for 200, and for a 404
     * that is a Blockchair answer naming no error.
     *
     * A 404 IS NOT A NEGATIVE BY ITSELF. Blockchair's docs give it two meanings: "no results" on some
     * endpoints (a behaviour they call deprecated) and a route it does not serve — a retired chain
     * slug, a renamed endpoint — and a proxy or CDN in front can answer 404 with an HTML page. Read
     * as "no results", the last two wrote a zero balance and "never used" onto every address of a
     * batch. So a 404 with `context.error` set, or without Blockchair's JSON, fails the request;
     * one that passes still has to carry a well-formed `data` before lookup.ts reads it as empty.
     *
     * Status meanings are Blockchair's documented ones; two are MEASURED (2026-11-14, without a
     * usable key): a key Blockchair does not know → 402 "Invalid API token…", and a keyless request
     * from a blocked IP → 430 "Your IP address is temporary blacklisted…". Both carry
     * `Access-Control-Allow-Origin: *`, so the web build reads them too.
     */
    async get(path: string, query: Record<string, string> = {}): Promise<Answer> {
        const qs = new URLSearchParams({ ...query, key: this.key }).toString();
        const url = `${API}/${path}?${qs}`;
        for (let attempt = 0; ; attempt++) {
            if (this.ctx.signal?.aborted) throw abortErr();
            await this.pause(this.last + PACE_MS - Date.now());
            this.last = Date.now();
            this.requests++;
            let res;
            try {
                res = await this.ctx.net!.fetch!(url);
            } catch (e) {
                if (this.ctx.signal?.aborted) throw abortErr();
                throw new ItemFailed(this.say(`no answer from Blockchair (${oneLine(e instanceof Error ? e.message : e)})`));
            }
            let json: any = null;
            try {
                const text = await res.text();
                json = text ? parseExact(text) : null;
            } catch {
                json = null;
            }
            const ctxCost = Number(json?.context?.request_cost);
            if (Number.isFinite(ctxCost) && ctxCost > 0) this.cost += ctxCost;
            const status = res.status;
            const why = this.say(oneLine(json?.context?.error ?? ''));
            const said = why ? `: ${why}` : '';

            if (status === 429 || status === 435) {
                if (attempt < 3) {
                    const waitMs = backoffMs(attempt, Number(res.headers?.['retry-after'] ?? NaN));
                    this.ctx.progress?.log?.(`Blockchair is rate-limiting (HTTP ${status}) — waiting ${Math.round(waitMs / 1000)}s`);
                    await this.pause(waitMs);
                    continue;
                }
                throw new StopRun(`Blockchair kept refusing requests (HTTP ${status}) after three waits${said}`);
            }
            if (status === 402) {
                // One status for two causes: an unknown key and a used-up quota. Blockchair's own
                // message is the only thing that tells them apart, so it is passed on.
                if (/invalid|token|key/i.test(why) && !/limit|exceed|quota/i.test(why)) {
                    throw new StopRun(`Blockchair does not accept this API key (HTTP 402${said}). Check the key in this plugin's settings`);
                }
                throw new StopRun(`Blockchair refused the request for the key's plan (HTTP 402${said}). The daily request counter resets at 00:00 UTC`);
            }
            if (status === 436 || status === 437) throw new StopRun(`Blockchair says a request limit was exceeded (HTTP ${status}${said})`);
            if (status === 430 || status === 434) {
                throw new StopRun(
                    `Blockchair has blocked requests from this IP address (HTTP ${status}${said}). Blockchair says a valid key is never blocked — check the key in this plugin's settings`,
                );
            }
            if (status === 503 && /blacklist|blocked/i.test(why)) {
                throw new StopRun(`Blockchair has blocked requests from this IP address (HTTP 503${said})`);
            }
            if (status >= 500 && attempt < 1) {
                await this.pause(3_000);
                continue;
            }
            if (status === 404) {
                const blockchair = !!json && typeof json === 'object' && !!json.context && typeof json.context === 'object';
                if (!blockchair) throw new ItemFailed('Blockchair answered HTTP 404 with something that is not its JSON (a route it does not serve, or a page in front of it)');
                if (why) throw new ItemFailed(`Blockchair answered HTTP 404${said}`);
                return { data: json.data ?? null, context: json.context };
            }
            if (status === 400) throw new ItemFailed(`Blockchair refused the request as malformed (HTTP 400${said})`, 400);
            if (status < 200 || status >= 300) throw new ItemFailed(`Blockchair answered HTTP ${status}${said}`, status);
            if (!json || typeof json !== 'object') throw new ItemFailed('Blockchair answered with something that is not JSON');
            return { data: json.data ?? null, context: json.context ?? {} };
        }
    }
}

/** The analyst's key, trimmed, or ''. Never logged, never put anywhere but the request URL. */
export function apiKey(ctx: HostContext): string {
    const k = ctx.config?.api_key;
    return typeof k === 'string' ? k.trim() : '';
}

export function requireKey(ctx: HostContext): string {
    const k = apiKey(ctx);
    if (!k) {
        throw new Error(
            "Blockchair API key is not set. Blockchair requires a key for any commercial project, and keyless requests are blocked often — get one at https://blockchair.com/api/plans and paste it into this plugin's settings.",
        );
    }
    return k;
}

/**
 * Blockchair's `data` as a plain object. Its answers come from PHP, where an empty associative
 * array serialises as `[]`, so `[]` and `{}` both read as no entries. `null` reads as no entries
 * too, which is why lookup.ts checks for a well-formed answer BEFORE calling this: a missing `data`
 * is a failed request, not an empty one.
 */
export const asMap = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

/**
 * Polite HTTP: first-byte (4 s) and total (10 s) timeouts, one retry on 429/5xx
 * honoring Retry-After, per-host minimum spacing and request limits (arXiv, CrossRef,
 * Semantic Scholar with a key, dblp's SPARQL service), and a per-host circuit breaker:
 * after 2 consecutive timeouts, network errors or 5xx answers the host is skipped
 * for the rest of the run. Until a host has answered once (and while it is failing)
 * only one request to it is in flight, so concurrent entries do not all wait out
 * the same timeout.
 */

import type { RefsOptions } from './types.js';

export interface HttpResponse {
  status: number;
  body: string;
  contentType: string;
}

/** A source could not give a definitive answer (network, timeout, 5xx, bot wall). */
export class SourceUnavailableError extends Error {
  readonly host: string;
  constructor(host: string, message: string) {
    super(message);
    this.host = host;
    this.name = 'SourceUnavailableError';
  }
}

const MAX_RETRY_AFTER_MS = 30_000;
/** Consecutive failures (timeout, network error, 5xx) that take a host out for the run. */
const BREAKER_THRESHOLD = 2;
/** Time allowed until response headers arrive. */
const FIRST_BYTE_TIMEOUT_MS = 4000;
/**
 * Hosts that run the whole search before they send headers, so a healthy answer can
 * start later than FIRST_BYTE_TIMEOUT_MS: Europe PMC's search took 0.6 to 15 s per
 * request on 2026-11-18, whatever the query; dblp's SPARQL service took 0.6 to 3 s, and
 * up to 28 s for the first query after a quiet spell. They get the whole timeout instead.
 */
const SLOW_FIRST_BYTE_HOSTS = new Set(['www.ebi.ac.uk', 'sparql.dblp.org']);
const CROSSREF = 'api.crossref.org';
/**
 * dblp's SPARQL service is one shared machine, and each query costs it real work: one
 * query at a time, at least a second apart. Its robots.txt allows /sparql (the
 * Crawl-delay there is for crawlers of the site).
 */
const DBLP_SPARQL = 'sparql.dblp.org';
const DBLP_SPARQL_SPACING = { intervalMs: 1000, concurrent: 1 };

/**
 * CrossRef's limits (its REST API documentation, "Etiquette"): the public pool allows about
 * one request per second, one at a time; the polite pool (a `mailto` contact) about three
 * per second and three at a time. The spacing keeps a little below each.
 */
const CROSSREF_PUBLIC = { intervalMs: 1100, concurrent: 1 };
const CROSSREF_POLITE = { intervalMs: 350, concurrent: 3 };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });
}

function retryAfterMs(header: string | null, fallback: number): number {
  if (header === null) return fallback;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(Math.max(0, seconds * 1000), MAX_RETRY_AFTER_MS);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
  return fallback;
}

export class HttpClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly intervals: Record<string, number>;
  /** Most requests in flight per host, for hosts that limit it. */
  private readonly limits: Record<string, number>;
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, (() => void)[]>();
  private readonly nextSlot = new Map<string, number>();
  private readonly down = new Map<string, string>();
  private readonly failures = new Map<string, number>();
  /** Hosts that have answered at least once this run. */
  private readonly healthy = new Set<string>();
  /** The single in-flight probe request of a host that is unproven or failing. */
  private readonly probing = new Map<string, Promise<void>>();
  private readonly firstByteMs: number;

  constructor(opts: RefsOptions) {
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error('no fetch available; pass opts.fetch');
    // Browsers throw "Illegal invocation" when window.fetch is called as a method of
    // another object, so always call it detached from `this`.
    this.fetchFn = (input, init) => f.call(globalThis, input, init);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.firstByteMs = Math.min(FIRST_BYTE_TIMEOUT_MS, this.timeoutMs);
    this.retryDelayMs = opts.retryDelayMs ?? 1000;
    this.signal = opts.signal;
    const crossref = opts.mailto ? CROSSREF_POLITE : CROSSREF_PUBLIC;
    this.intervals = {
      'export.arxiv.org': opts.arxivIntervalMs ?? 3000,
      [CROSSREF]: opts.crossrefIntervalMs ?? crossref.intervalMs,
      // Semantic Scholar's key allows 1 request per second; keyless requests share a pool.
      ...(opts.semanticScholarKey ? { 'api.semanticscholar.org': 1100 } : {}),
      [DBLP_SPARQL]: opts.dblpSparqlIntervalMs ?? DBLP_SPARQL_SPACING.intervalMs,
    };
    this.limits = {
      [CROSSREF]: crossref.concurrent,
      [DBLP_SPARQL]: DBLP_SPARQL_SPACING.concurrent,
    };
  }

  /** Why the host is out for the rest of this run; undefined while it is usable. */
  downReason(host: string): string | undefined {
    return this.down.get(host);
  }

  /** Marks a host as unusable for the rest of this run (e.g. a bot challenge). */
  markDown(host: string, reason: string): void {
    this.down.set(host, reason);
  }

  /**
   * GET with the given Accept header. Resolves for any final HTTP status
   * (callers decide what 404 means); throws SourceUnavailableError when no
   * definitive answer was obtained.
   */
  async get(url: string, accept: string, headers?: Record<string, string>): Promise<HttpResponse> {
    const host = new URL(url).host;
    const release = await this.acquire(host);
    let free: (() => void) | undefined;
    try {
      free = await this.slot(host);
      return await this.getOnce(url, accept, host, headers);
    } finally {
      free?.();
      release();
    }
  }

  /** Waits until the host has room for one more request in flight (see `limits`). */
  private async slot(host: string): Promise<() => void> {
    const limit = this.limits[host];
    if (!limit) return () => {};
    while ((this.active.get(host) ?? 0) >= limit) {
      await new Promise<void>((resolve) => {
        const queue = this.waiting.get(host) ?? [];
        queue.push(resolve);
        this.waiting.set(host, queue);
      });
    }
    this.active.set(host, (this.active.get(host) ?? 0) + 1);
    return () => {
      this.active.set(host, (this.active.get(host) ?? 1) - 1);
      this.waiting.get(host)?.shift()?.();
    };
  }

  private async getOnce(
    url: string,
    accept: string,
    host: string,
    headers?: Record<string, string>,
  ): Promise<HttpResponse> {
    let res = await this.attempt(url, accept, host, headers);
    if (res.status === 429 && /daily|budget|quota|per day|credits/i.test(res.body)) {
      // A used-up daily budget does not come back after a retry: fail fast for the run.
      const reason = `${host} answered HTTP 429: daily request budget used up`;
      this.markDown(host, reason);
      throw new SourceUnavailableError(host, reason);
    }
    if (res.status >= 500) this.recordFailure(host, `${host} answered HTTP ${res.status}`);
    if (res.status === 429 || res.status >= 500) {
      const downReason = this.down.get(host);
      if (downReason) throw new SourceUnavailableError(host, downReason);
      await sleep(retryAfterMs(res.retryAfter, this.retryDelayMs), this.signal);
      res = await this.attempt(url, accept, host, headers);
    }
    if (res.status === 429 || res.status >= 500) {
      const reason = `${host} answered HTTP ${res.status}`;
      // A 5xx was counted above; a repeated 429 counts once here.
      if (res.status === 429 || !this.down.has(host)) this.recordFailure(host, reason);
      throw new SourceUnavailableError(host, this.down.get(host) ?? reason);
    }
    this.failures.delete(host);
    this.healthy.add(host);
    return { status: res.status, body: res.body, contentType: res.contentType };
  }

  /**
   * Throws when the host is down. A host that has not answered yet, or is failing,
   * lets one request through at a time; the others wait for its outcome.
   */
  private async acquire(host: string): Promise<() => void> {
    for (;;) {
      const downReason = this.down.get(host);
      if (downReason) throw new SourceUnavailableError(host, downReason);
      if (this.signal?.aborted) throw this.signal.reason ?? new Error('aborted');
      const unproven = !this.healthy.has(host) || (this.failures.get(host) ?? 0) > 0;
      if (!unproven) return () => {};
      const other = this.probing.get(host);
      if (!other) break;
      await other;
    }
    let done!: () => void;
    const gate = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.probing.set(host, gate);
    return () => {
      this.probing.delete(host);
      done();
    };
  }

  /** Consecutive failures take a host out for the rest of the run. */
  private recordFailure(host: string, reason: string): void {
    const n = (this.failures.get(host) ?? 0) + 1;
    this.failures.set(host, n);
    if (n >= BREAKER_THRESHOLD && !this.down.has(host))
      this.markDown(host, `${reason} (repeatedly; skipped for the rest of this run)`);
  }

  private async throttle(host: string): Promise<void> {
    const interval = this.intervals[host] ?? 0;
    if (interval <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, slot + interval);
    await sleep(slot - now, this.signal);
  }

  private async attempt(
    url: string,
    accept: string,
    host: string,
    headers?: Record<string, string>,
  ): Promise<HttpResponse & { retryAfter: string | null }> {
    if (this.signal?.aborted) throw this.signal.reason ?? new Error('aborted');
    await this.throttle(host);
    const controller = new AbortController();
    const onAbort = () => controller.abort(this.signal?.reason);
    this.signal?.addEventListener('abort', onAbort, { once: true });
    const firstByteMs = SLOW_FIRST_BYTE_HOSTS.has(host) ? this.timeoutMs : this.firstByteMs;
    let timedOutAfter = firstByteMs;
    const firstByte = setTimeout(() => controller.abort(new Error('timeout')), firstByteMs);
    const total = setTimeout(() => {
      timedOutAfter = this.timeoutMs;
      controller.abort(new Error('timeout'));
    }, this.timeoutMs);
    try {
      const res = await this.fetchFn(url, {
        headers: { Accept: accept, ...(headers ?? {}) },
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(firstByte);
      const body = await res.text();
      return {
        status: res.status,
        body,
        contentType: res.headers.get('content-type') ?? '',
        retryAfter: res.headers.get('retry-after'),
      };
    } catch (err) {
      if (this.signal?.aborted) throw this.signal.reason ?? err;
      const timedOut = controller.signal.aborted;
      const why = timedOut
        ? `timed out after ${timedOutAfter} ms`
        : `network error (${(err as Error).message})`;
      const reason = `${host}: ${why}`;
      this.recordFailure(host, reason);
      throw new SourceUnavailableError(host, reason);
    } finally {
      clearTimeout(firstByte);
      clearTimeout(total);
      this.signal?.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * GET + JSON.parse. A non-JSON body (bot walls answer 200/202 with HTML)
 * takes the host out for the rest of the run and throws SourceUnavailableError.
 */
export async function getJson<T>(
  client: HttpClient,
  url: string,
  accept = 'application/json',
  headers?: Record<string, string>,
): Promise<{ status: number; data: T | null }> {
  const res = await client.get(url, accept, headers);
  if (res.status === 404 || res.status === 410) return { status: res.status, data: null };
  const host = new URL(url).host;
  if (res.status < 200 || res.status >= 300) {
    throw new SourceUnavailableError(host, `${host} answered HTTP ${res.status}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(res.body);
  } catch {
    const reason = `${host} returned a non-JSON page (HTTP ${res.status}); it may be blocking automated requests`;
    client.markDown(host, reason);
    throw new SourceUnavailableError(host, reason);
  }
  // Every source answers with a JSON object; anything else is not an answer.
  if (!isObject(data)) throw unexpectedData(host);
  return { status: res.status, data: data as T };
}

/** A plain JSON object (not null, not an array). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A source answered, but not in the shape its API documents. */
export function unexpectedData(host: string): SourceUnavailableError {
  return new SourceUnavailableError(host, `${host} returned unexpected data`);
}

/**
 * The list at `value` in a source's answer. Absent is `[]` only where the API leaves an
 * empty list out (`optional`); anything else that is not an array is unexpected data.
 */
export function listIn(host: string, value: unknown, optional = false): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined && optional) return [];
  throw unexpectedData(host);
}

/**
 * Reads a parsed answer. A TypeError while reading it (a field of another type than the API
 * documents, such as a number where a string belongs) becomes "unexpected data" for that
 * source, never a crash with a JavaScript message.
 */
export function readAnswer<T>(host: string, read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (err instanceof TypeError) throw unexpectedData(host);
    throw err;
  }
}

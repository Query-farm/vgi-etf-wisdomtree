// The real WisdomTree HTTP client — the ONE module that touches the network, so (like the
// sibling SPDR/iShares clients) it is exercised live, not by the unit tests, which drive the pure
// driver in wisdomtree.ts through an injected `get`.
//
// WisdomTree serves both data planes (the /us/products lineup and each /us/products/{slug} fund
// page) as plain, keyless HTML — there is no login and no JSON API. `get(url)` returns the page
// TEXT; the driver extracts the embedded React Server Components payload from it.
//
// One non-obvious requirement: WisdomTree sits behind Cloudflare, which fingerprints the caller.
// A browser-like User-Agent is necessary but, from some hosts, not sufficient — Cloudflare can
// 403 a plain `fetch` on its TLS/HTTP fingerprint alone (proven: an identical request over
// HTTP/1.1 via the system `curl` is accepted where `fetch` is blocked). So `get` fetches
// normally and, ONLY if that comes back 403, transparently retries the SAME request over
// HTTP/1.1 through a `curl` subprocess. It stays HTTP-only (no browser/automation); it is a
// reachability fallback, not a scraper. The fallback is off whenever a custom `fetchImpl` is
// injected, so the unit tests never hit the network.
//
// CATALOG CACHE: the ~0.8 MB products page backs `products` and every fund resolution, and
// changes at most once a day. So the client memoizes just that one URL with a 24 h TTL (shared
// across queries in a long-lived stdio/HTTP process). Fund pages always go live. The in-flight
// Promise is cached (not only the resolved value) so concurrent first requests coalesce into one
// fetch; a failed fetch is evicted so the next call retries.

import { PRODUCTS_URL } from "./wisdomtree.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const ACCEPT_LANG = "en-US,en;q=0.9";

/** Default products-page cache lifetime: 24 hours. */
export const CATALOG_CACHE_MS = 24 * 60 * 60 * 1000;

type FetchLike = typeof globalThis.fetch;

/** The injected transport the table functions call: an HTML `get`. */
export interface WisdomtreeClient {
  get: (url: string) => Promise<string>;
}

export interface WisdomtreeClientOptions {
  /** Products-page cache TTL in ms (default 24 h). Pass 0 to disable caching. */
  catalogCacheMs?: number;
  /** Injectable clock (ms since epoch) — for tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Retry a 403 over HTTP/1.1 via the system `curl` (default true). Forced OFF automatically when
   * a custom `fetchImpl` is injected, so the unit tests never shell out or touch the network.
   */
  curlFallback?: boolean;
}

/** Fetch a page over HTTP/1.1 with the system `curl`, browser UA. Throws if curl is unavailable/fails. */
async function curlGet(url: string): Promise<string> {
  const proc = Bun.spawn(
    ["curl", "-sS", "--http1.1", "--compressed", "--max-time", "60",
      "-A", UA, "-H", `Accept: ${ACCEPT}`, "-H", `Accept-Language: ${ACCEPT_LANG}`, url],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [body, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`wisdomtree: curl exit ${code} for ${url} — ${err.slice(0, 200)}`);
  return body;
}

/**
 * Build the injectable `{ get }` client. `fetchImpl` defaults to the platform fetch; pass one in
 * for Cloudflare-workers or to stub the network. The products page is memoized for
 * `catalogCacheMs` (default 24 h); fund-page fetches are never cached.
 */
export function makeWisdomtreeGet(
  fetchImpl: FetchLike = globalThis.fetch,
  opts: WisdomtreeClientOptions = {},
): WisdomtreeClient {
  const ttl = opts.catalogCacheMs ?? CATALOG_CACHE_MS;
  const now = opts.now ?? (() => Date.now());
  // The curl fallback is only meaningful for the real platform fetch; an injected fetch disables it.
  const curlFallback = opts.curlFallback ?? fetchImpl === globalThis.fetch;
  let catalog: { at: number; value: Promise<string> } | null = null;

  const rawGet = async (url: string): Promise<string> => {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": UA, Accept: ACCEPT, "Accept-Language": ACCEPT_LANG },
    });
    // Cloudflare fingerprint block → retry the same request over HTTP/1.1 via curl.
    if (res.status === 403 && curlFallback) return curlGet(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`wisdomtree: HTTP ${res.status} for ${url} — ${body.slice(0, 200)}`);
    }
    return res.text();
  };

  const get = async (url: string): Promise<string> => {
    if (ttl > 0 && url === PRODUCTS_URL) {
      const t = now();
      if (!catalog || t - catalog.at >= ttl) {
        const value = rawGet(url);
        catalog = { at: t, value };
        value.catch(() => {
          if (catalog && catalog.value === value) catalog = null;
        });
      }
      return catalog.value;
    }
    return rawGet(url);
  };

  return { get };
}

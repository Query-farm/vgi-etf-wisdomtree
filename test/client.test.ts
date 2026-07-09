// Cache behavior of the real client's `get`. The client is otherwise verified live, but the 24 h
// products-page memoization is pure logic, so it's unit-tested here with an injected fetch
// (call-counting) and an injected clock. No network: an injected fetchImpl also disables the curl
// fallback, so a non-ok status throws rather than shelling out.

import { test, expect } from "bun:test";
import { makeWisdomtreeGet } from "../src/client.js";
import { PRODUCTS_URL, fundPageUrl } from "../src/wisdomtree.js";

/** A fake fetch that counts calls and returns a canned HTML body. */
function countingFetch(body = "<html>ok</html>") {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      text: async () => body,
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

const FUND_URL = fundPageUrl("equity/dgrw");

test("products page is fetched once then served from cache within the TTL", async () => {
  const { impl, calls } = countingFetch();
  let clock = 1_000_000;
  const { get } = makeWisdomtreeGet(impl, { now: () => clock });
  await get(PRODUCTS_URL);
  await get(PRODUCTS_URL);
  clock += 60 * 60 * 1000; // +1 h, still within the 24 h TTL
  await get(PRODUCTS_URL);
  expect(calls.length).toBe(1);
});

test("products page is refetched after the TTL expires", async () => {
  const { impl, calls } = countingFetch();
  let clock = 0;
  const { get } = makeWisdomtreeGet(impl, { now: () => clock });
  await get(PRODUCTS_URL);
  clock += 24 * 60 * 60 * 1000 + 1; // just past 24 h
  await get(PRODUCTS_URL);
  expect(calls.length).toBe(2);
});

test("concurrent first products-page requests coalesce into a single fetch", async () => {
  const { impl, calls } = countingFetch();
  const { get } = makeWisdomtreeGet(impl);
  await Promise.all([get(PRODUCTS_URL), get(PRODUCTS_URL), get(PRODUCTS_URL)]);
  expect(calls.length).toBe(1);
});

test("fund pages are never cached", async () => {
  const { impl, calls } = countingFetch();
  const { get } = makeWisdomtreeGet(impl);
  await get(FUND_URL);
  await get(FUND_URL);
  expect(calls.length).toBe(2);
});

test("catalogCacheMs: 0 disables caching", async () => {
  const { impl, calls } = countingFetch();
  const { get } = makeWisdomtreeGet(impl, { catalogCacheMs: 0 });
  await get(PRODUCTS_URL);
  await get(PRODUCTS_URL);
  expect(calls.length).toBe(2);
});

test("a failed products-page fetch is evicted so the next call retries", async () => {
  const calls: string[] = [];
  let failNext = true;
  const impl = (async (url: string) => {
    calls.push(url);
    if (failNext) {
      failNext = false;
      return { ok: false, status: 503, text: async () => "down" } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => "<html>ok</html>" } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  const { get } = makeWisdomtreeGet(impl);
  await expect(get(PRODUCTS_URL)).rejects.toThrow(/HTTP 503/);
  const ok = await get(PRODUCTS_URL); // cache was evicted → retries and succeeds
  expect(ok).toBe("<html>ok</html>");
  expect(calls.length).toBe(2);
});

test("an injected fetch never triggers the curl fallback (a 403 throws instead)", async () => {
  const impl = (async () =>
    ({ ok: false, status: 403, text: async () => "blocked" }) as unknown as Response) as unknown as typeof globalThis.fetch;
  const { get } = makeWisdomtreeGet(impl, { catalogCacheMs: 0 });
  await expect(get(PRODUCTS_URL)).rejects.toThrow(/HTTP 403/);
});

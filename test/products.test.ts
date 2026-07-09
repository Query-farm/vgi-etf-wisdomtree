// Archetype proof for wisdomtree.products: the /us/products catalog driver. Imports ONLY our own
// src + the fake — NO @query-farm/* — so it runs without the SDK installed. Proves the __next_f
// extraction, the product-object parse (ticker / name / category tiers), the slug map, fund
// resolution, and the products-page URL contract.

import { test, expect } from "bun:test";
import {
  extractNextF,
  parseProducts,
  fetchProducts,
  resolveFund,
  slugMap,
  PRODUCTS_URL,
} from "../src/wisdomtree.js";
import { FakeWisdomtree, productsPayload, nextPage } from "./fake-wisdomtree.js";

test("extractNextF concatenates + unescapes the __next_f chunks back into one payload", () => {
  const payload = '{"a":"b","c":[1,2,3]}';
  expect(extractNextF(nextPage(payload))).toBe(payload);
  // A page with no chunks yields an empty payload (not a throw).
  expect(extractNextF("<html></html>")).toBe("");
});

test("parseProducts maps the internalLink product objects to product rows", () => {
  const rows = parseProducts(productsPayload());
  expect(rows.length).toBe(3);
  const dgrw = rows.find((r) => r.ticker === "DGRW")!;
  expect(dgrw.fundName).toBe("U.S. Quality Dividend Growth Fund");
  expect(dgrw.assetClass).toBe("Domestic Equity"); // fundCategoryTier1, read across the nested policies[]
  expect(dgrw.category).toBe("Large Cap Core"); // fundCategoryTier2
  expect(dgrw.subCategory).toBeNull(); // fundCategoryTier3 is null
  expect(dgrw.productPageUrl).toBe("/us/products/equity/dgrw");
  const aggy = rows.find((r) => r.ticker === "AGGY")!;
  expect(aggy.assetClass).toBe("Fixed Income");
});

test("parseProducts is sorted by ticker and deduplicates", () => {
  const rows = parseProducts(productsPayload());
  expect(rows.map((r) => r.ticker)).toEqual(["AGGY", "DGRW", "EPS"]);
});

test("parseProducts narrows to a single ticker (case-insensitive)", () => {
  const one = parseProducts(productsPayload(), "dgrw");
  expect(one.length).toBe(1);
  expect(one[0]!.ticker).toBe("DGRW");
  expect(parseProducts(productsPayload(), "ZZZZ")).toEqual([]);
});

test("parseProducts tolerates junk without throwing", () => {
  expect(parseProducts("")).toEqual([]);
  expect(parseProducts("<not json>")).toEqual([]);
  expect(parseProducts('{"x":1}')).toEqual([]);
});

test("slugMap maps ticker → fund-page slug", () => {
  const m = slugMap(productsPayload());
  expect(m.get("DGRW")).toBe("equity/dgrw");
  expect(m.get("AGGY")).toBe("fixed-income/aggy");
});

test("fetchProducts hits the products URL once", async () => {
  const fake = FakeWisdomtree.site();
  const rows = await fetchProducts(fake.get);
  expect(rows.length).toBe(3);
  expect(fake.calls).toEqual([PRODUCTS_URL]);
});

test("resolveFund returns the ticker + slug, or null on a miss", async () => {
  const fake = FakeWisdomtree.site();
  expect(await resolveFund(fake.get, "dgrw")).toEqual({ ticker: "DGRW", slug: "equity/dgrw" });
  expect(await resolveFund(fake.get, "ZZZZ")).toBeNull();
  expect(await resolveFund(fake.get, "")).toBeNull();
});

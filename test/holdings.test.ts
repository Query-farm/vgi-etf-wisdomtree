// Archetype proof for wisdomtree.holdings: the fundHoldingDetails parser, the date parser (with
// the RSC `$D` sentinel), constituent-ticker cleaning, and the fetch orchestration. SDK-free
// (imports only our own src + the fake, no @query-farm).

import { test, expect } from "bun:test";
import { parseHoldings, fetchHoldings, parseDate } from "../src/wisdomtree.js";
import {
  FakeWisdomtree,
  dgrwHoldingsPayload,
  epsHoldingsPayload,
} from "./fake-wisdomtree.js";

test("parseDate handles the RSC $D-prefixed ISO timestamp and plain ISO, keeping the UTC day", () => {
  const jul8 = Math.floor(Date.UTC(2026, 6, 8) / 1000);
  expect(parseDate("$D2026-07-08T00:00:00.000Z")).toBe(jul8);
  expect(parseDate("2026-07-08")).toBe(jul8);
  expect(parseDate("-")).toBeNull();
  expect(parseDate(null)).toBeNull();
  expect(parseDate("garbage")).toBeNull();
});

test("parseHoldings maps the fundHoldingDetails rows, sorts by weight desc, and scales weight", () => {
  const rows = parseHoldings(dgrwHoldingsPayload(), "DGRW");
  expect(rows.length).toBe(4); // 3 equities + 1 cash; the classification array is ignored
  expect(rows.map((r) => r.name)).toEqual(["Nvidia Corp", "Apple Inc", "Alphabet Inc", "US DOLLAR"]);
  const nvda = rows[0]!;
  expect(nvda.fundTicker).toBe("DGRW");
  expect(nvda.ticker).toBe("NVDA"); // "NVDA UQ" → exchange suffix stripped
  expect(nvda.figi).toBe("BBG000BBJQV0");
  expect(nvda.assetGroup).toBe("EQ");
  expect(nvda.shares).toBe(6590518);
  expect(nvda.marketValue).toBe(1345256534.16);
  expect(nvda.weightPercent).toBeCloseTo(8.08, 5); // 0.0808 fraction → percent points
  expect(nvda.asOfDate).toBe(Math.floor(Date.UTC(2026, 6, 8) / 1000));
});

test("parseHoldings keeps a suffix-less ticker as-is and nulls the cash row's ticker", () => {
  const rows = parseHoldings(dgrwHoldingsPayload(), "DGRW");
  const goog = rows.find((r) => r.name === "Alphabet Inc")!;
  expect(goog.ticker).toBe("GOOG"); // no exchange suffix — unchanged
  const cash = rows.find((r) => r.assetGroup === "CA")!;
  expect(cash.ticker).toBeNull(); // securityTicker was null
  expect(cash.name).toBe("US DOLLAR");
});

test("parseHoldings returns [] when the page has no fundHoldingDetails", () => {
  expect(parseHoldings('{"someOtherKey":[]}', "X")).toEqual([]);
  expect(parseHoldings("", "X")).toEqual([]);
});

test("fetchHoldings fetches the fund page and parses its holdings (one request)", async () => {
  const fake = FakeWisdomtree.site();
  const rows = await fetchHoldings(fake.get, { ticker: "DGRW", slug: "equity/dgrw" });
  expect(rows.length).toBe(4);
  expect(fake.calls).toEqual(["https://www.wisdomtree.com/us/products/equity/dgrw"]);
});

test("fetchHoldings on a second fund returns that fund's rows", async () => {
  const fake = FakeWisdomtree.site();
  const rows = await fetchHoldings(fake.get, { ticker: "EPS", slug: "equity/eps" });
  expect(rows.map((r) => r.ticker)).toEqual(["MSFT", "AVGO"]);
  // sanity: the EPS payload really is distinct from DGRW's
  expect(epsHoldingsPayload()).toContain("Microsoft Corp");
});

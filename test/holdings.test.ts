// Archetype proof for wisdomtree.holdings: the fundHoldingDetails parser, the date parser (with
// the RSC `$D` sentinel), constituent-ticker cleaning, and the fetch orchestration. SDK-free
// (imports only our own src + the fake, no @query-farm).

import { test, expect } from "bun:test";
import {
  parseHoldings,
  fetchHoldings,
  parseDate,
  fundPageUrl,
  fundHoldingsApiUrl,
} from "../src/wisdomtree.js";
import {
  FakeWisdomtree,
  nextPage,
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

// Regression: since 2026-11 the real fund page no longer embeds the constituent list — it ships
// `"fundHoldingDetails":"$undefined"` + the fund's entityId, and the holdings modal lazy-loads the
// same objects from /api/fund-holdings/{entityId}. The old parser silently returned 0 rows for
// EVERY fund (holdings table empty). fetchHoldings must follow the entityId to the JSON route.
test("fetchHoldings follows the page's entityId to /api/fund-holdings when nothing is embedded", async () => {
  const page =
    '{"sectionKey":"holdings","ranking":[{"constituentName":"Microsoft Corp","pctWeight":0.078}],' +
    '"entityId":"1000521","fundHoldingDetails":"$undefined","tableFooter":"$L88"}';
  const api = JSON.stringify([
    { dt: "2026-11-13T00:00:00.000Z", fundTicker: "DGRW", assetGroup: "EQ", securityTicker: "NVDA UQ",
      securityName: "Nvidia Corp", shares: 6778519, marketValueBase: 1103881819.15, wgt: 0.0629, figi: "BBG000BBJQV0" },
    { dt: "2026-11-13T00:00:00.000Z", fundTicker: "DGRW", assetGroup: "EQ", securityTicker: "MSFT US",
      securityName: "Microsoft Corp", shares: 2629891, marketValueBase: 1377747297.08, wgt: 0.0786, figi: "BBG000BPH459" },
  ]);
  const fake = new FakeWisdomtree((url) => {
    if (url === fundPageUrl("equity/dgrw")) return nextPage(page);
    if (url === fundHoldingsApiUrl("1000521")) return api;
    throw new Error(`404 for ${url}`);
  });
  const rows = await fetchHoldings(fake.get, { ticker: "dgrw", slug: "equity/dgrw" });
  expect(fake.calls).toEqual([
    "https://www.wisdomtree.com/us/products/equity/dgrw",
    "https://www.wisdomtree.com/api/fund-holdings/1000521",
  ]);
  expect(rows.map((r) => r.ticker)).toEqual(["MSFT", "NVDA"]); // weight-desc, suffix stripped
  expect(rows[0]!.fundTicker).toBe("DGRW");
  expect(rows[0]!.weightPercent).toBeCloseTo(7.86, 5);
  expect(rows[0]!.asOfDate).toBe(Math.floor(Date.UTC(2026, 10, 13) / 1000));
});

test("fetchHoldings returns [] when the page has neither embedded holdings nor an entityId", async () => {
  const fake = new FakeWisdomtree(() => nextPage('{"fundHoldingDetails":"$undefined"}'));
  expect(await fetchHoldings(fake.get, { ticker: "X", slug: "equity/x" })).toEqual([]);
  expect(fake.calls.length).toBe(1);
});

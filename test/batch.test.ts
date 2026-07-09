// Typed-column contract for the two schemas. This one pulls @query-farm/vgi (batchFromColumns) +
// apache-arrow, so it runs under the full SDK install — unlike the driver tests, which are
// deliberately SDK-free. Proves schema field names/order and that Utf8/Float64/Date cells (incl.
// nulls) round-trip into an Arrow batch.

import { test, expect } from "bun:test";
import {
  productsSchema,
  productsBatch,
  holdingsSchema,
  holdingsBatch,
} from "../src/schema.js";
import { parseProducts, parseHoldings } from "../src/wisdomtree.js";
import { productsPayload, dgrwHoldingsPayload } from "./fake-wisdomtree.js";

const names = (schema: { fields: { name: string }[] }) => schema.fields.map((f) => f.name);

test("products schema field names + order", () => {
  expect(names(productsSchema())).toEqual([
    "ticker", "fund_name", "asset_class", "category", "sub_category", "product_page_url",
  ]);
});

test("holdings schema field names + order", () => {
  expect(names(holdingsSchema())).toEqual([
    "fund_ticker", "as_of_date", "name", "ticker", "figi", "asset_group", "weight_percent",
    "shares", "market_value",
  ]);
});

test("batch builders produce one row per parsed record", () => {
  expect((productsBatch(productsSchema(), parseProducts(productsPayload())) as { numRows: number }).numRows).toBe(3);
  expect((holdingsBatch(holdingsSchema(), parseHoldings(dgrwHoldingsPayload(), "DGRW")) as { numRows: number }).numRows).toBe(4);
});

test("empty inputs build a zero-row batch, not a throw", () => {
  expect((productsBatch(productsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((holdingsBatch(holdingsSchema(), []) as { numRows: number }).numRows).toBe(0);
});

// The VGI surfaces: the products & holdings base-table backing scans. All keyless. The products
// state is just a `done` flag (fully serializable — no socket / batch / Date), so the HTTP
// transport can round-trip it; the holdings scan streams via a BoundStorage work queue. The
// WisdomTree client is injected so worker.ts wires the real fetch and tests wire a fake.

import {
  defineTableFunction,
  batchFromColumns,
  serializeBatch,
  deserializeFilters,
  buildJoinKeysLookup,
  DEFAULT_MAX_WORKERS,
  type OutputCollector,
} from "@query-farm/vgi";
import { Schema, Field, Utf8 } from "@query-farm/apache-arrow";
import { fetchProducts, fetchHoldings, slugMap, extractNextF, PRODUCTS_URL } from "./wisdomtree.js";
import {
  productsSchema,
  productsBatch,
  holdingsSchema,
  holdingsBatch,
  resultColumnsSchema,
} from "./schema.js";
import type { WisdomtreeClient } from "./client.js";

// Per-column descriptions for the `vgi.result_columns_schema` tag (JSON [{name,type,description}],
// generated from the holdings Arrow schema via resultColumnsSchema).
const HOLDINGS_SCAN_DESCS: Record<string, string> = {
  fund_ticker: "The fund's ticker — the partition filter.",
  as_of_date: "The holdings as-of date (the fund page's own publication date).",
  name: "Constituent / security name.",
  ticker: "Constituent ticker (exchange suffix stripped; null for cash / FX rows).",
  figi: "Constituent FIGI identifier.",
  asset_group: "Asset group of the holding: EQ (equity), CA (cash), etc.",
  weight_percent: "Percent of the fund, 0–100 (7.38 = 7.38%).",
  shares: "Number of shares (or units) of the constituent held by the fund.",
  market_value: "Market value of the position, in the fund's base currency (USD).",
};

interface DoneState {
  done: boolean;
}

// ── holdings queue plumbing (BoundStorage work queue + hive partition metadata) ──
//
// The holdings scan streams one fund per partition. `onInit` seeds a BoundStorage queue with the
// target funds (one item each); each `process()` tick pops a fund, fetches its holdings, and emits
// one SINGLE_VALUE partition. Multiple parallel workers drain the same execution-scoped queue, so
// the fan-out is naturally work-stealing and bounded by maxWorkers.

/** A queued fund: its exchange ticker (the partition value) + its catalog slug (the page path). */
interface FundItem {
  ticker: string;
  slug: string;
}
const encodeFund = (item: FundItem): Uint8Array => new TextEncoder().encode(JSON.stringify(item));
const decodeFund = (bytes: Uint8Array): FundItem => JSON.parse(new TextDecoder().decode(bytes));

/** Plain (non-annotated) field used to build the partition-values (min,max) batch. */
const FUND_TICKER_FIELD = new Field("fund_ticker", new Utf8(), true);

const b64encode = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/**
 * Build the `vgi_partition_values#b64` batch metadata for a SINGLE_VALUE partition: a 2-row
 * (min,max) Arrow batch over fund_ticker where min == max == the fund's ticker.
 */
function partitionValues(ticker: string): Map<string, string> {
  const batch = batchFromColumns({ fund_ticker: [ticker, ticker] }, new Schema([FUND_TICKER_FIELD]));
  return new Map([["vgi_partition_values#b64", b64encode(serializeBatch(batch))]]);
}

// ── products (backing scan for the products TABLE) ──────────────────────────────
//
// `products` is exposed as a real base TABLE (see catalog.ts `tables`), not a table function, so
// users query `FROM wisdomtree.products` (no parens) and filter with WHERE — no arguments. This
// zero-arg scan is registered only for scan dispatch (it is NOT listed among the catalog's
// callable functions). It returns the full WisdomTree US ETF lineup; a WHERE on
// ticker / asset_class narrows it.

export function makeProductsScan(client: WisdomtreeClient) {
  const schema = productsSchema();
  return defineTableFunction<Record<string, never>, DoneState>({
    name: "products",
    description: "WisdomTree US ETF catalog — backing scan for the products table.",
    args: {},
    onBind: () => ({ outputSchema: schema }),
    initialState: () => ({ done: false }),
    process: async (_p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const rows = await fetchProducts(client.get);
      out.emit(productsBatch(schema, rows));
      state.done = true;
    },
  });
}

// ── holdings (backing scan for the holdings TABLE) ─────────────────────────────
//
// `holdings` is exposed as a base TABLE (see catalog.ts), HIVE-PARTITIONED on `fund_ticker` (the
// fund's ticker — distinct from the constituent `ticker` column). WisdomTree embeds only the
// CURRENT constituent list on each fund page, so — unlike the sibling iShares worker — there is
// NO time travel and no as-of argument; `as_of_date` reflects the fund page's own publication date.
//   SELECT * FROM wisdomtree.main.holdings WHERE fund_ticker = 'DGRW';
//   SELECT * FROM wisdomtree.main.holdings WHERE fund_ticker IN ('DGRW','EPS'); -- fan-out per partition
//   SELECT * FROM wisdomtree.main.holdings;                                     -- ALL funds (every partition)
//
// Each fund is one SINGLE_VALUE partition. The scan is a streaming, queue-backed generator:
//   • onInit (runs once on the coordinator) reads the pushed fund_ticker filter — or, absent one,
//     the ENTIRE ETF catalog — resolves each ticker to its fund-page slug, and pushes one item per
//     fund onto a BoundStorage work queue.
//   • process() pops one fund per tick, fetches its fund page, and emits a single partition batch.
// filterPushdown + being LISTED is what lets DuckDB push fund_ticker into the scan.

export function makeHoldingsScan(client: WisdomtreeClient) {
  const schema = holdingsSchema();
  return defineTableFunction<Record<string, never>, Record<string, never>>({
    name: "holdings",
    description:
      "Backing scan for the holdings table — prefer the `holdings` table. Detailed fund " +
      "holdings, hive-partitioned by fund_ticker: filter WHERE fund_ticker = 'DGRW' (or " +
      "fund_ticker IN (…)) for specific funds, or scan with no filter to stream every fund's " +
      "holdings. weight_percent is in percent points.",
    args: {},
    // filterPushdown MUST be declared AND this function MUST be listed in the catalog so the DuckDB
    // extension can discover the capability and push the fund_ticker filter into the table scan.
    // Each fund is one SINGLE_VALUE partition (fund_ticker is the hive partition key).
    filterPushdown: true,
    partitionKind: "SINGLE_VALUE_PARTITIONS",
    maxWorkers: DEFAULT_MAX_WORKERS,
    onBind: () => ({ outputSchema: schema }),
    // Seed the work queue (once, on the coordinator): one item per target fund (ticker + slug).
    onInit: async ({ initCall, executionId, storage }) => {
      const joinKeys = buildJoinKeysLookup(initCall.join_keys);
      const filters = initCall.pushdown_filters
        ? deserializeFilters(initCall.pushdown_filters, joinKeys)
        : undefined;
      const requested = (filters?.getColumnValues("fund_ticker") ?? []).map((t) =>
        String(t).toUpperCase(),
      );
      // Resolve the fund universe (ticker → slug) from the (cached) products page. One fetch either way.
      const slugs = slugMap(extractNextF(await client.get(PRODUCTS_URL)));
      const targets: FundItem[] =
        requested.length > 0
          ? requested
              .filter((t) => slugs.has(t))
              .map((t) => ({ ticker: t, slug: slugs.get(t)! }))
          : [...slugs.entries()].map(([ticker, slug]) => ({ ticker, slug }));
      await storage.queuePush(targets.map(encodeFund));
      return { max_workers: DEFAULT_MAX_WORKERS, execution_id: executionId, opaque_data: null };
    },
    initialState: () => ({}),
    process: async (p, _state, out: OutputCollector) => {
      // Pop one fund per tick; emit exactly one partition. Skip funds whose page has no embedded
      // holdings (or that error) and pop the next. Queue empty → end of scan.
      for (;;) {
        const item = await p.storage!.queuePop();
        if (item === null) {
          out.finish();
          return;
        }
        const fund = decodeFund(item);
        let rows;
        try {
          rows = await fetchHoldings(client.get, fund);
        } catch {
          continue; // a fund page we couldn't fetch — skip it
        }
        if (rows.length === 0) continue;
        out.emit(holdingsBatch(schema, rows), partitionValues(fund.ticker));
        return;
      }
    },
    examples: [
      { sql: "SELECT name, weight_percent FROM wisdomtree.main.holdings() WHERE fund_ticker = 'DGRW' ORDER BY weight_percent DESC LIMIT 10", description: "Top 10 holdings of DGRW via the backing scan" },
      { sql: "SELECT fund_ticker, count(*) FROM wisdomtree.main.holdings() WHERE fund_ticker IN ('DGRW', 'EPS') GROUP BY fund_ticker", description: "Two partitions at once (fan-out)" },
    ],
    tags: {
      "vgi.category": "holdings",
      "vgi.doc_llm":
        "The backing scan for the `holdings` table. Prefer querying the `holdings` table. " +
        "Hive-partitioned by fund_ticker (the fund's ticker, distinct from the constituent " +
        "`ticker` column): filter WHERE fund_ticker = '…' (or fund_ticker IN (…)) for specific " +
        "funds, or scan with no filter to stream every fund (~85 partitions — slow). " +
        "weight_percent is in percent points (7.38 = 7.38%). WisdomTree publishes current " +
        "holdings only, so there is no historical as-of date.",
      "vgi.doc_md":
        "## holdings (backing scan)\n\n" +
        "The backing scan for the **`holdings` table** — prefer the table. Hive-partitioned by " +
        "`fund_ticker`: filter `WHERE fund_ticker = 'DGRW'` for one fund, or scan with no filter " +
        "to stream every fund (see the example queries). `fund_ticker` is distinct from the " +
        "constituent `ticker` column.",
      "vgi.result_columns_schema": resultColumnsSchema(holdingsSchema(), HOLDINGS_SCAN_DESCS),
      // Mirror `examples` as described example_queries — the native duckdb_functions().examples
      // carrier drops descriptions, so VGI515 needs the descriptions on this tag.
      "vgi.example_queries": JSON.stringify([
        { description: "Top 10 holdings of DGRW via the backing scan", sql: "SELECT name, weight_percent FROM wisdomtree.main.holdings() WHERE fund_ticker = 'DGRW' ORDER BY weight_percent DESC LIMIT 10" },
        { description: "Two partitions at once (fan-out)", sql: "SELECT fund_ticker, count(*) FROM wisdomtree.main.holdings() WHERE fund_ticker IN ('DGRW', 'EPS') GROUP BY fund_ticker" },
      ]),
    },
  });
}

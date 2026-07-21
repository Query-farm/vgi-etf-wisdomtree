// The `wisdomtree` catalog descriptor + its metadata tags (the vgi.* discovery/doc channels
// vgi-lint grades). WisdomTree's public product / fund pages are KEYLESS, so there is NO secret
// type here.
//
// Tag shapes follow vgi-lint's TAGS.md: JSON-valued tags (keywords/categories/
// executable_examples/agent_test_tasks) are JSON strings; all example SQL is
// catalog-qualified (wisdomtree.main.<obj>) so it binds/runs when the catalog is attached.

import type { CatalogDescriptor, VgiFunction } from "@query-farm/vgi";
import { Arguments } from "@query-farm/vgi";
import { productsSchema, holdingsSchema, resultColumnsSchema } from "./schema.js";

const REPO = "https://github.com/Query-farm/vgi-etf-wisdomtree";
const ISSUES = `${REPO}/issues`;

/** Per-column comments for the products table (surface as Arrow field metadata). */
const PRODUCTS_COLUMN_COMMENTS: Record<string, string> = {
  ticker: "Exchange ticker (e.g. DGRW).",
  fund_name: "Fund name as marketed, e.g. 'U.S. Quality Dividend Growth Fund'.",
  asset_class: "Top-level asset class (e.g. Domestic Equity, International Equity, Fixed Income, Alternative, Megatrends, Crypto ETPs).",
  category: "Fund category within the asset class (e.g. Large Cap Core).",
  sub_category: "Finer sub-category, when WisdomTree assigns one (often empty).",
  product_page_url: "Path to the fund page on wisdomtree.com.",
};

/** Table-level metadata for the products base table (the vgi.* doc/discovery channels). */
const PRODUCTS_TABLE_TAGS: Record<string, string> = {
  "vgi.category": "catalog",
  domain: "finance",
  "vgi.keywords": JSON.stringify([
    "ETF",
    "fund catalog",
    "product list",
    "asset class",
    "ticker",
    "WisdomTree",
  ]),
  "vgi.doc_llm":
    "The WisdomTree US ETF catalog as a plain table (query it directly, no arguments): one row " +
    "per ETF with ticker, fund name, and its asset-class / category classification. Narrow it " +
    "with a WHERE clause on ticker, asset_class, and so on. Start here to find a fund's ticker " +
    "for the holdings table.",
  "vgi.doc_md":
    "## products\n\n" +
    "The WisdomTree US ETF catalog as a base table — one row per fund. It takes no arguments; " +
    "query it directly and filter with a WHERE clause (e.g. `WHERE asset_class = 'Domestic " +
    "Equity'`; see the example queries). The ticker column is the key for the holdings table.",
  "vgi.example_queries": JSON.stringify([
    { description: "All WisdomTree US ETFs", sql: "SELECT ticker, fund_name, asset_class FROM wisdomtree.main.products ORDER BY ticker" },
    { description: "Domestic-equity funds", sql: "SELECT ticker, fund_name, category FROM wisdomtree.main.products WHERE asset_class = 'Domestic Equity' ORDER BY ticker" },
    { description: "Look up a single fund by ticker", sql: "SELECT ticker, fund_name, asset_class FROM wisdomtree.main.products WHERE ticker = 'DGRW'" },
    { description: "Fund count by asset class", sql: "SELECT asset_class, count(*) AS fund_count FROM wisdomtree.main.products GROUP BY asset_class ORDER BY fund_count DESC" },
  ]),
  "vgi.result_columns_schema": resultColumnsSchema(productsSchema(), PRODUCTS_COLUMN_COMMENTS),
};

/** Per-column comments for the holdings table. */
const HOLDINGS_COLUMN_COMMENTS: Record<string, string> = {
  fund_ticker: "The fund's ticker (e.g. DGRW) — the hive partition key; constant for every row of a fund. Filter on it to pick funds; omit to stream all.",
  as_of_date: "Holdings as-of date (the fund page's own publication date; current holdings only).",
  name: "Constituent / security name.",
  ticker: "Constituent ticker (exchange suffix stripped; null for cash / FX rows).",
  figi: "Constituent FIGI identifier.",
  asset_group: "Asset group of the holding: EQ (equity), CA (cash), etc.",
  weight_percent: "Percent of the fund, 0–100 (7.38 = 7.38%; weights sum to ~100).",
  shares: "Number of shares (or units) of the constituent held by the fund.",
  market_value: "Market value of the position, in the fund's base currency (USD).",
};

/** Table-level metadata for the holdings base table (ticker-partitioned, current holdings). */
const HOLDINGS_TABLE_TAGS: Record<string, string> = {
  "vgi.category": "holdings",
  domain: "finance",
  "vgi.keywords": JSON.stringify([
    "holdings",
    "constituents",
    "portfolio",
    "weights",
    "positions",
    "exposure",
  ]),
  "vgi.doc_llm":
    "Detailed portfolio holdings for WisdomTree ETFs as a hive-partitioned table. It is " +
    "partitioned by fund_ticker (the FUND's ticker, distinct from the constituent `ticker` " +
    "column): filter `WHERE fund_ticker = '…'` (or `fund_ticker IN (…)`) to pick funds, or scan " +
    "with no filter to stream EVERY fund's holdings (~85 funds — slow, so prefer a filter). " +
    "WisdomTree publishes CURRENT holdings only, so there is no historical as-of date; " +
    "as_of_date is the fund page's own date. Rows come back weight-descending; weight_percent is " +
    "in percent points (7.38 = 7.38%). Join on fund_ticker to products.ticker for fund-level facts.",
  "vgi.doc_md":
    "## holdings\n\n" +
    "Detailed fund holdings as a **hive-partitioned table**, partitioned by `fund_ticker` (the " +
    "fund's ticker). `fund_ticker` is distinct from `ticker` (the constituent's own ticker). " +
    "Filter `WHERE fund_ticker = 'DGRW'` for one fund's holdings (see the example queries).\n\n" +
    "`WHERE fund_ticker IN ('DGRW','EPS')` fans out per partition; an unfiltered scan streams " +
    "every fund (~85 partitions — slow). WisdomTree publishes **current holdings only** (no " +
    "historical dates). `weight_percent` is in percent points (7.38 = 7.38%).",
  "vgi.result_columns_schema": resultColumnsSchema(holdingsSchema(), HOLDINGS_COLUMN_COMMENTS),
  "vgi.example_queries": JSON.stringify([
    { description: "Top 10 current holdings of DGRW", sql: "SELECT name, ticker, weight_percent FROM wisdomtree.main.holdings WHERE fund_ticker = 'DGRW' ORDER BY weight_percent DESC LIMIT 10" },
    { description: "Largest positions by market value", sql: "SELECT name, market_value FROM wisdomtree.main.holdings WHERE fund_ticker = 'DGRW' ORDER BY market_value DESC LIMIT 10" },
    { description: "Two funds at once (partition fan-out)", sql: "SELECT fund_ticker, name, weight_percent FROM wisdomtree.main.holdings WHERE fund_ticker IN ('DGRW', 'EPS')" },
    { description: "Top holdings enriched with the fund name (join to products)", sql: "SELECT p.fund_name, h.name, h.weight_percent FROM wisdomtree.main.holdings h JOIN wisdomtree.main.products p ON h.fund_ticker = p.ticker WHERE h.fund_ticker = 'DGRW' ORDER BY h.weight_percent DESC LIMIT 10" },
  ]),
};

/** Catalog-level tags: docs, discovery, provenance, and the agent-test suite. */
const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "WisdomTree ETFs",
  "vgi.doc_llm":
    "WisdomTree US ETF data as SQL tables. Reach for it to browse the ETF lineup and its " +
    "asset-class classification, and to inspect what a fund currently holds. The central concept " +
    "is the fund, identified by its exchange ticker (e.g. DGRW); start from the catalog to find " +
    "that key, then drill into a specific fund's holdings. Data is WisdomTree's public fund " +
    "pages: best-effort, for informational use.",
  "vgi.doc_md":
    "## WisdomTree ETFs\n\n" +
    "WisdomTree US ETF data, exposed as DuckDB tables.\n\n" +
    "The **fund** is the unit of the data and is keyed by an exchange `ticker` (e.g. `DGRW`) — " +
    "begin at the catalog to discover that key, then drill into a fund's holdings. Holdings are " +
    "the current published portfolio (WisdomTree does not publish historical holdings).\n\n" +
    "Data is provided for informational use; review WisdomTree's terms before redistribution.",
  "vgi.keywords": JSON.stringify([
    "ETF",
    "WisdomTree",
    "holdings",
    "portfolio",
    "fund",
    "constituents",
    "asset class",
    "index fund",
    "dividend",
  ]),
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC",
  "vgi.license": "MIT",
  "vgi.support_contact": ISSUES,
  "vgi.support_policy_url": ISSUES,
  // At least one guaranteed-runnable example at the catalog level (VGI509). No expected_result —
  // WisdomTree data is live/non-deterministic.
  "vgi.executable_examples": JSON.stringify([
    {
      name: "etf_lineup",
      description: "The WisdomTree US ETF lineup",
      sql: "SELECT ticker, fund_name, asset_class FROM wisdomtree.main.products ORDER BY ticker LIMIT 5",
    },
    {
      name: "top_holdings",
      description: "The top holdings of the WisdomTree U.S. Quality Dividend Growth Fund",
      sql: "SELECT name, ticker, weight_percent FROM wisdomtree.main.holdings WHERE fund_ticker = 'DGRW' ORDER BY weight_percent DESC LIMIT 5",
    },
  ]),
  // Agent-suitability suite (catalog only). Each task carries a deterministic check_sql that
  // asserts specific ground truth; reference_sql is deliberately omitted (live data). One task per
  // callable surface (products, holdings table, holdings() scan) satisfies VGI520.
  "vgi.agent_test_tasks": JSON.stringify([
    {
      name: "dgrw_exists",
      prompt: "Does WisdomTree offer an ETF with the ticker DGRW, and what is it called?",
      check_sql: "SELECT count(*) > 0 FROM wisdomtree.main.products WHERE ticker = 'DGRW'",
      success_criteria: "The answer confirms DGRW is the WisdomTree U.S. Quality Dividend Growth Fund, found via the products table.",
    },
    {
      name: "equity_funds",
      prompt: "List a few WisdomTree domestic-equity ETFs.",
      check_sql: "SELECT count(*) > 0 FROM wisdomtree.main.products WHERE asset_class = 'Domestic Equity'",
      success_criteria: "The answer names several domestic-equity WisdomTree ETFs from the products table.",
    },
    {
      name: "dgrw_top_holding",
      prompt: "What is the single largest holding of the WisdomTree U.S. Quality Dividend Growth Fund (DGRW) right now?",
      check_sql: "SELECT count(*) > 0 FROM wisdomtree.main.holdings WHERE fund_ticker = 'DGRW'",
      success_criteria: "The answer names DGRW's top holding by weight, obtained from the holdings table.",
    },
    {
      name: "dgrw_holdings_scan",
      prompt: "Using the holdings backing scan function, list a few DGRW constituents by weight.",
      check_sql: "SELECT count(*) > 0 FROM wisdomtree.main.holdings() WHERE fund_ticker = 'DGRW'",
      success_criteria: "The answer returns DGRW constituents via the holdings() backing scan function filtered by fund_ticker.",
    },
  ]),
};

/** Schema-level tags: docs, discovery, the category registry, and shown examples. */
const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "WisdomTree Fund Data",
  "vgi.doc_llm":
    "Tables that return WisdomTree ETF data at two levels. At the catalog level you browse the " +
    "whole lineup and resolve a fund's key. At the fund level you drill into one fund — its " +
    "current holdings. A fund is keyed by its exchange `ticker` (e.g. `DGRW`); resolve the key " +
    "at the catalog level first.",
  "vgi.doc_md":
    "## WisdomTree fund data\n\n" +
    "Work happens at two levels. **Catalog level:** browse the lineup and find a fund's key. " +
    "**Fund level:** drill into a single fund — its constituents. A fund is keyed by its exchange " +
    "`ticker` (e.g. `DGRW`).\n\n" +
    "Holdings are the current published portfolio; WisdomTree does not publish historical holdings.",
  "vgi.keywords": JSON.stringify(["ETF holdings", "fund catalog", "portfolio", "WisdomTree", "constituents"]),
  domain: "finance",
  // Ordered navigation registry; each `name` is referenced by a table's vgi.category.
  "vgi.categories": JSON.stringify([
    { name: "catalog", title: "Fund Catalog", description: "The ETF product list and its classification." },
    { name: "holdings", title: "Holdings", description: "Detailed current portfolio holdings." },
  ]),
  "vgi.example_queries": JSON.stringify([
    { description: "The WisdomTree US ETF lineup", sql: "SELECT ticker, fund_name, asset_class FROM wisdomtree.main.products ORDER BY ticker" },
    { description: "Top holdings of DGRW", sql: "SELECT name, ticker, weight_percent FROM wisdomtree.main.holdings WHERE fund_ticker = 'DGRW' ORDER BY weight_percent DESC LIMIT 10" },
  ]),
};

/**
 * @param functions    the callable table functions — empty here (products and holdings are base
 *                      tables). Kept for parity with the sibling workers' signature.
 * @param productsScan  the zero-arg scan backing the `products` base table.
 * @param holdingsScan  the pushdown scan backing the `holdings` base table.
 * Both scans are registered for scan dispatch but exposed to DuckDB only as tables (except that
 * holdingsScan is also LISTED so the extension can push the fund_ticker filter into it).
 */
export function makeCatalog(
  functions: VgiFunction[],
  productsScan: VgiFunction,
  holdingsScan: VgiFunction,
): CatalogDescriptor {
  return {
    name: "wisdomtree",
    defaultSchema: "main",
    comment:
      "WisdomTree US ETF data as DuckDB tables: products (catalog) & holdings " +
      "(ticker-partitioned) — vgi-etf-wisdomtree",
    sourceUrl: REPO,
    tags: CATALOG_TAGS,
    schemas: [
      {
        name: "main",
        comment: "WisdomTree fund data: the ETF catalog and detailed current holdings.",
        tags: SCHEMA_TAGS,
        functions: [...functions, holdingsScan],
        tables: [
          {
            name: "products",
            function: productsScan,
            arguments: new Arguments([], new Map()),
            // Each fund is identified by its exchange ticker (advisory — not enforced on scan).
            primaryKey: [["ticker"]],
            // The WisdomTree US ETF lineup is ~85 funds; headroom to ~150.
            inlinedCardinality: { estimate: 85n, max: 150n },
            comment:
              "Every WisdomTree US ETF with its classification, one row per fund. Query directly " +
              "(no arguments) and filter with WHERE.",
            columnComments: PRODUCTS_COLUMN_COMMENTS,
            tags: PRODUCTS_TABLE_TAGS,
          },
          {
            name: "holdings",
            function: holdingsScan,
            arguments: new Arguments([], new Map()),
            // fund_ticker is always populated (the scan tags every row with its fund).
            notNull: ["fund_ticker"],
            // Advisory composite key (NOT enforced on scan): a holdings row is one constituent of
            // one fund, so (fund_ticker, ticker) is how an agent references a row. `ticker`
            // completes the key for securities; a small number of non-equity line items (cash, FX)
            // carry a null constituent ticker.
            primaryKey: [["fund_ticker", "ticker"]],
            // Hive partition key: fund_ticker. A WHERE fund_ticker = … / IN (…) filter is pushed
            // down to fetch just those funds; an unfiltered scan streams every fund (all partitions).
            // WisdomTree publishes current holdings only, so there is NO time travel.
            // Whole-table estimate: ~85 funds × ~200 constituents each. A single-fund filter scans
            // one partition (~200 rows; broad funds like EPI can reach ~1000+).
            inlinedCardinality: { estimate: 20000n, max: 200000n },
            comment:
              "Detailed current fund holdings, hive-partitioned by fund_ticker (filter WHERE " +
              "fund_ticker = … for one fund, or scan unfiltered for all). WisdomTree publishes " +
              "current holdings only (no historical dates).",
            columnComments: HOLDINGS_COLUMN_COMMENTS,
            tags: HOLDINGS_TABLE_TAGS,
          },
        ],
      },
    ],
  };
}

// Composed example queries — each combines the worker's own objects (products × holdings, or
// holdings × holdings) in one realistic query. Defined ONCE here and referenced from catalog.ts:
// the schema-level vgi.example_queries list AND the example list of the object that drives the
// query (within its first 5, so the vgi-lint agent simulator — which only shows per-object
// examples — sees them). The README carries LCV_CONSENSUS_HOLDINGS too.

export interface ExampleQuery {
  description: string;
  sql: string;
}

/** products → holdings: the catalog's category filter picks the funds, holdings is aggregated. */
export const LCV_CONSENSUS_HOLDINGS: ExampleQuery = {
  description:
    "Stocks held by the most WisdomTree Large Cap Value funds, with each stock's average weight " +
    "across those funds (products category filter joined to holdings; scans every fund's holdings)",
  sql:
    "SELECT h.ticker, h.name, count(*) AS funds_holding, round(avg(h.weight_percent), 2) AS avg_weight_percent " +
    "FROM wisdomtree.main.products p JOIN wisdomtree.main.holdings h ON h.fund_ticker = p.ticker " +
    "WHERE p.category = 'Large Cap Value' AND h.asset_group = 'EQ' " +
    "GROUP BY h.ticker, h.name ORDER BY funds_holding DESC, avg_weight_percent DESC, h.ticker LIMIT 10",
};

/** holdings → products: a constituent filter across every fund, enriched with fund-level facts. */
export const NVDA_HOLDERS: ExampleQuery = {
  description:
    "Every WisdomTree ETF that holds NVIDIA, with the fund's name, asset class and NVDA weight " +
    "(holdings filtered on the constituent ticker, joined to products; scans every fund's holdings)",
  sql:
    "SELECT p.ticker AS fund_ticker, p.fund_name, p.asset_class, round(h.weight_percent, 2) AS weight_percent " +
    "FROM wisdomtree.main.holdings h JOIN wisdomtree.main.products p ON p.ticker = h.fund_ticker " +
    "WHERE h.ticker = 'NVDA' ORDER BY h.weight_percent DESC, p.ticker",
};

/** holdings × holdings: classic two-fund overlap on the constituent FIGI. */
export const DGRW_DLN_OVERLAP: ExampleQuery = {
  description:
    "Portfolio overlap between DGRW and DLN: the number of shared equity holdings and the weight " +
    "overlap in percent (sum over shared stocks of the smaller of the two weights)",
  sql:
    "SELECT count(*) AS shared_holdings, round(sum(least(a.weight_percent, b.weight_percent)), 1) AS overlap_percent " +
    "FROM wisdomtree.main.holdings a JOIN wisdomtree.main.holdings b ON a.figi = b.figi " +
    "WHERE a.fund_ticker = 'DGRW' AND b.fund_ticker = 'DLN' AND a.asset_group = 'EQ' AND b.asset_group = 'EQ'",
};

# vgi-etf-wisdomtree

A [VGI](https://query.farm) worker that exposes **WisdomTree** US ETF data as DuckDB tables — the
ETF catalog and a partitioned holdings table.

| Object | What it returns | WisdomTree source |
| --- | --- | --- |
| `wisdomtree.products` (table) | Every US ETF with its classification, one row per fund | `/us/products` page |
| `wisdomtree.holdings` (table) | Detailed current holdings, partitioned by fund_ticker | `/us/products/{slug}` fund page |

Everything rides WisdomTree's public website — there is no secret to create and no login. Funds
are identified by their exchange **ticker** (e.g. `DGRW`).

Two conventions to know:
- **Dates are real `DATE` columns** (no timezone) — compare them directly, e.g.
  `WHERE as_of_date = DATE '2026-07-08'`.
- **Percent columns carry a `_percent` suffix and hold percent points**: `weight_percent` = 7.38
  means 7.38% (weights sum to ~100).

> **Current holdings only.** WisdomTree embeds a single, current constituent list on each fund
> page, so `holdings` has **no time travel / as-of argument** — `as_of_date` reflects the page's
> own publication date. (This matches the sibling `vgi-etf-spdr` worker and differs from `vgi-etf-ishares`.)

> **Status:** initial build. Unit tests (SDK-free driver + Arrow batch builders), own-source
> typecheck, a live HTTP-transport smoke test, the haybarn SQLLogic E2E suite against a real
> DuckDB + the community `vgi` extension, and a `vgi-lint` metadata gate at 100/100 all pass.

## Install / attach

### Option A — prebuilt binary (recommended)

Each release ships a self-contained executable per platform, so the host needs **neither Bun nor
`node_modules`**. Archives are named `vgi-etf-wisdomtree-<tag>-<platform>.tar.gz` for `linux_amd64`,
`linux_arm64`, `osx_amd64`, `osx_arm64`, and `windows_amd64`, each with a SHA256, a keyless
**cosign** signature, and a **SLSA** build-provenance attestation.

```bash
tar xzf vgi-etf-wisdomtree-v0.1.0-osx_arm64.tar.gz     # → vgi-etf-wisdomtree-worker
```

```sql
LOAD vgi;
ATTACH 'wisdomtree' AS wisdomtree (TYPE vgi, LOCATION '/path/to/vgi-etf-wisdomtree-worker');
```

### Option B — from source (Bun)

For development or the latest `main`, run the worker on [Bun](https://bun.sh):

```bash
bun install
```

```sql
LOAD vgi;
ATTACH 'wisdomtree' AS wisdomtree (TYPE vgi, LOCATION '/path/to/vgi-etf-wisdomtree/bin/vgi-etf-wisdomtree-worker');
```

`bin/vgi-etf-wisdomtree-worker` is a small wrapper that launches `src/worker.ts` under Bun.

### Option C — container image (ghcr.io)

A multi-arch (linux/amd64 + linux/arm64), cosign-signed image is published to
`ghcr.io/query-farm/vgi-etf-wisdomtree` on every release — no local Bun or worker binary needed.
Attach it directly over the VGI container transport:

```sql
LOAD vgi;
ATTACH 'wisdomtree' AS wisdomtree (TYPE vgi, LOCATION 'oci://ghcr.io/query-farm/vgi-etf-wisdomtree:latest');
```

Or run the HTTP transport yourself and attach that:

```bash
docker run --rm -p 8000:8000 ghcr.io/query-farm/vgi-etf-wisdomtree:latest   # serves /health + the VGI RPC on :8000
```

```sql
LOAD vgi;
ATTACH 'wisdomtree' AS wisdomtree (TYPE vgi, LOCATION 'http://localhost:8000');
```

`:latest` always tracks the newest release.

## Usage

### products — the fund catalog (a base table)

`products` is a plain **table** — no arguments, no parentheses. It returns the whole ETF lineup;
filter with `WHERE`.

```sql
-- The full WisdomTree US ETF lineup:
SELECT ticker, fund_name, asset_class, category
FROM wisdomtree.products
ORDER BY ticker;

-- Domestic-equity funds:
SELECT ticker, fund_name, category
FROM wisdomtree.products
WHERE asset_class = 'Domestic Equity'
ORDER BY ticker;

-- Look up one fund by ticker:
SELECT ticker, fund_name, asset_class
FROM wisdomtree.products
WHERE ticker = 'DGRW';
```

Columns: `ticker`, `fund_name`, `asset_class` (e.g. `'Domestic Equity'`, `'International Equity'`,
`'Fixed Income'`, `'Alternative'`, `'Megatrends'`, `'Crypto ETPs'`, `'Capital Efficient ETFs'`,
`'Emerging Markets Equity'`), `category` (finer bucket), `sub_category`, and `product_page_url`.

### holdings — a hive-partitioned table

`holdings` is a **table hive-partitioned by `fund_ticker`** (the fund's ticker). Filter
`fund_ticker` to pick funds, or scan without a filter to stream **every** fund's holdings (one
partition per fund — ~85 funds, so prefer a filter).

```sql
-- Top 10 current holdings of DGRW (already weight-ordered):
SELECT name, ticker, weight_percent, shares
FROM wisdomtree.holdings
WHERE fund_ticker = 'DGRW'
ORDER BY weight_percent DESC
LIMIT 10;

-- Several funds at once (partition fan-out):
SELECT fund_ticker, name, weight_percent
FROM wisdomtree.holdings
WHERE fund_ticker IN ('DGRW', 'EPS');

-- Largest positions by market value:
SELECT name, market_value
FROM wisdomtree.holdings
WHERE fund_ticker = 'DGRW'
ORDER BY market_value DESC
LIMIT 10;
```

`fund_ticker` is the **fund's** ticker and the hive partition key — distinct from the `ticker`
column (each row's own constituent ticker; null for cash / FX rows). Other columns: `name`,
`figi`, `asset_group` (`EQ` equity, `CA` cash, …), `weight_percent` (percent points), `shares`,
`market_value` (USD). Rows come back **weight-descending**. `as_of_date` (DATE) is the fund page's
publication date — WisdomTree publishes **current holdings only**, so there is no historical time
travel. Join `holdings.fund_ticker` to `products.ticker` for fund-level facts.

> A backing `holdings()` scan function is also exposed under the same name as the `holdings` table
> (it's what the table scans, and it's what lets DuckDB push the `fund_ticker` filter) — prefer the
> `holdings` table.

## Development

```bash
bun install
bun test            # unit tests (SDK-free driver + Arrow batch builders + live HTTP transport)
bun run typecheck   # own-source typecheck (see scripts/typecheck.sh)
./run_tests.sh      # haybarn SQLLogic E2E under a real DuckDB + the community vgi extension
```

The E2E suite needs the haybarn runner and the vgi extension, once:

```bash
uv tool install haybarn-unittest
echo "INSTALL vgi FROM community;" | uvx haybarn-cli
```

Metadata quality is graded by [`vgi-lint`](https://github.com/Query-farm/vgi-lint-check);
CI runs it as a gate at 100/100. Locally:

```bash
uvx --prerelease allow --from vgi-lint-check vgi-lint bin/vgi-etf-wisdomtree-worker --fail-on info
```

The pure request/response logic lives in `src/wisdomtree.ts` and is fully unit-tested against an
in-process fake (`test/fake-wisdomtree.ts`) — no network. The single module that touches the
network is `src/client.ts`.

## Where the data comes from: `__next_f` HTML, not an API

WisdomTree's site is a Next.js App-Router app; there is **no public JSON API** (its own Sanity
GROQ endpoint is ACL-locked). Both data planes are served as HTML pages that stream their data as
React Server Component payloads inside inline `self.__next_f.push([…])` script chunks:

- **Catalog** — `GET /us/products` embeds the whole lineup as Sanity `internalLink` product
  objects (ticker, title, category tiers, slug). `extractNextF()` concatenates + unescapes the
  chunks; `parseProducts()` reads the product objects out of the decoded payload.
- **Holdings** — `GET /us/products/{slug}` (e.g. `equity/dgrw`) embeds the fund's full constituent
  list as a `fundHoldingDetails` array — real values (securityName, securityTicker, shares,
  marketValueBase, wgt, figi), not just a rendered top-10. `parseHoldings()` reads that array.

So `client.get(url)` returns page **text** (HTML), and the driver extracts the embedded JSON.
There is **no `.xlsx`/CSV holdings download** — the only spreadsheet linked from a fund page is a
multi-fund NAV *tracking-analysis* workbook, not holdings — so this worker needs no spreadsheet
parser.

### Cloudflare note

WisdomTree sits behind Cloudflare, which fingerprints callers. A browser-like User-Agent is
necessary but, from some hosts, not sufficient — Cloudflare can `403` a plain `fetch` on its
TLS/HTTP fingerprint alone. So `client.get` fetches normally and, **only** if that returns `403`,
transparently retries the identical request over HTTP/1.1 via the system `curl`. It stays
HTTP-only (no browser / automation) — a reachability fallback, not a scraper.

## Layout

```
src/wisdomtree.ts  Pure driver: __next_f extraction + catalog/holdings parsers + fetch orchestrators (no network, no SDK)
src/client.ts      Real HTTP client (browser User-Agent; keyless; curl-over-HTTP/1.1 fallback for Cloudflare)
src/schema.ts      Typed Arrow output schemas + row→batch builders
src/functions.ts   The products/holdings backing scans
src/catalog.ts     The `wisdomtree` catalog descriptor (no secret type)
src/worker.ts      Worker entry: wires the real client into the functions
bin/…-worker       Launch wrapper (bun run src/worker.ts) for DuckDB ATTACH
```

## Data source & terms

Data comes from WisdomTree's public website (the product catalog and per-fund pages). It is
provided for personal, informational use; consult WisdomTree's terms before any redistribution or
commercial use. This worker is not affiliated with or endorsed by WisdomTree.

## License

MIT — Copyright 2026 Query Farm LLC · https://query.farm

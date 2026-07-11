# vgi-etf-wisdomtree — agent notes

A VGI (DuckDB) worker exposing WisdomTree US ETF data as two base **tables** — `products` (the
catalog) and `holdings` (hive-partitioned) — the holdings table's backing scan is a listed table
function under the same `holdings` name (so DuckDB pushes the fund_ticker filter). TypeScript, runs on Bun, built on `@query-farm/vgi` (the TS SDK). Keyless — no secret type,
no auth. Modeled closely on the sibling `vgi-etf-spdr` worker (file-download issuer, current holdings
only); the KEY DIFFERENCE is the data SOURCE: WisdomTree has no JSON API and no `.xlsx` holdings —
both the catalog and the holdings are embedded in the page HTML as Next.js `__next_f` RSC chunks.

## Base tables (`products`, `holdings`) — two layers: registry vs listing

Tables are wired via `SchemaDescriptor.tables` (`makeCatalog`'s `tables: [...]`); each
`TableDescriptor` has `function: <scan>` + `arguments: new Arguments([], new Map())` and carries
its docs on `tags`/`comment`/`columnComments`. Two INDEPENDENT layers matter:
- **FunctionRegistry** (`registry.register(scan)`) — the *dispatch* layer. Required for a table to
  be scannable.
- **catalog `schemas[].functions`** — the *listing* layer. Controls what shows as a callable `X()`
  function AND is where the extension discovers a scan's capabilities (e.g. `filter_pushdown`).

`products`: backing `productsScan` is **registered but NOT listed** → exposed only as the table.
`holdings`: backing `holdingsScan` MUST be **listed** (`functions: [...functions, holdingsScan]`)
— an unlisted backing scan gets no `pushdown_filters` (the extension can't see its
`filter_pushdown` capability), so the `fund_ticker` partition filter never reaches it. Hence a
visible backing scan is unavoidable. To keep VGI311 clean (a listed parameterless table function
should be exposed as a table), the scan is named `holdings` — the same name as the `holdings` table
it backs — mirroring the sibling `vgi-etf-ishares` worker, rather than a distinct `holdings_scan`.
There are NO other
callable functions — `products` + `holdings` is the whole worker (no fund_details/nav_history:
WisdomTree lazy-loads fund-level facts via a client API, so the static HTML has none — only labels).

## `holdings` — hive-partitioned by `fund_ticker`, CURRENT holdings only (no time travel)

Query `FROM wisdomtree.main.holdings WHERE fund_ticker = 'DGRW'` (fund selector); an **unfiltered
scan streams every fund** (one partition per fund). Mechanics:
- **Hive partitioning + streaming queue.** `holdingsScan` is a `partitionKind:
  "SINGLE_VALUE_PARTITIONS"` generator — `fund_ticker` is the partition key (annotated
  `vgi.partition_column` in `holdingsSchema`). `onInit` reads the pushed `fund_ticker` filter (or,
  absent one, the whole catalog), resolves each ticker to its fund-page **slug** via the products
  page, and `queuePush`es one `{ticker,slug}` item per fund onto a `BoundStorage` queue keyed by
  the execution id. `process()` pops one fund per tick, fetches its fund page, and `out.emit`s a
  single partition batch tagged with `vgi_partition_values` (min==max==ticker). `maxWorkers`
  workers drain the same queue → work-stealing fan-out. `LIMIT` short-circuits the stream.
- **No time travel.** WisdomTree embeds only the current constituent list per fund page. There is
  deliberately NO `supportsTimeTravel` and NO as-of argument; `process()` never reads `p.atValue`.
  `as_of_date` is a real output column populated from each holding's `dt` field.
- **Skip-tolerant.** A fund page with no embedded `fundHoldingDetails` (or a fetch error) is
  skipped so an all-funds scan never fails on one fund.
- **`filterPushdown: true`** + LISTED → the extension pushes the `fund_ticker` filter into the scan.
- **`fund_ticker` is a SEPARATE column from `ticker`** — `ticker` is the CONSTITUENT's own ticker
  (null for cash/FX rows); `fund_ticker` is the fund's ticker, constant per fund. The scan tags
  every row with the requested fund ticker, upper-cased.
- Constraints: `products` advisory PK `[ticker]`, `holdings` `notNull [fund_ticker]`. No cross-table
  FK (identifier columns recur with different meanings). VGI311/807/809 waived with reasons.

## The data is `__next_f` HTML — NOT an API and NOT `.xlsx`

WisdomTree's site is a Next.js App-Router app. There is **no public JSON API** (its Sanity GROQ
endpoint is ACL-locked) and **no `.xlsx`/CSV holdings** (the only spreadsheet linked from a fund
page is a multi-fund NAV *tracking-analysis* workbook, irrelevant to holdings). So — unlike the
`vgi-etf-spdr` template it's modeled on — this worker has **no `xlsx`/SheetJS dependency and no
`getBytes`**; `client.get(url)` returns page **text (HTML)** and the driver extracts embedded JSON.

Both planes stream their data as RSC payloads inside inline `self.__next_f.push([N,"…"])` chunks.
`extractNextF(html)` concatenates every chunk's JS-string body and unescapes it (via
`JSON.parse('"'+body+'"')`) back into one decoded payload string. Then:
- **`parseProducts(payload)`** — the catalog. Each fund is a Sanity `internalLink` product object;
  its `slug`/`ticker`/`title` sit together at the object's tail, so the parser anchors on that trio
  and reads the category tiers (`fundCategoryTier1/2/3`) from the short window BEFORE it (Sanity
  serializes keys alphabetically, so the tiers are earlier in the SAME object, across a nested
  `policies[rules[]]` array). `slugMap()` gives ticker→slug for holdings resolution.
- **`parseHoldings(payload, fundTicker)`** — the fund's holdings: the `fundHoldingDetails` array
  (extracted with a quote/escape-aware `balancedArray` scan, then `JSON.parse`d). One object per
  constituent with REAL values: `securityName`→name, `securityTicker`→ticker (a trailing 2-letter
  Bloomberg exchange code like " UQ"/" US"/" UN" is stripped; cash rows have null), `figi`,
  `assetGroup` (EQ/CA/…), `shares`, `marketValueBase`→market_value, and `wgt` (a FRACTION 0–1 →
  `weight_percent` ×100). `dt` is the as-of date. `parseHoldings` sorts by `weight_percent` DESC
  (NULLS last) so `… LIMIT n` returns the top holdings.

## Architecture (keep this separation)

- **`src/wisdomtree.ts` — the pure driver.** `__next_f` extraction + catalog/holdings parsers, plus
  thin `fetch*` orchestrators and `resolveFund` that take an injected `get(url) => Promise<string>`
  (HTML). NO network, NO SDK import. This is what the unit tests exercise. All parsing is
  defensive: a missing chunk/key/field degrades to `[]`/`null`, never a throw. `resolveFund`
  returns `ResolvedFund | null` (null = not found) rather than throwing, so this module needs no
  SDK import.
- **`src/client.ts` — the only network module.** `makeWisdomtreeGet()` returns `{ get }`. `get`
  fetches HTML (and memoizes the products page for 24 h). Its jobs beyond `fetch`: (1) set the
  browser-like User-Agent WisdomTree requires; (2) a **Cloudflare fingerprint fallback** — if a
  `fetch` comes back `403`, retry the SAME request over HTTP/1.1 via a `curl` subprocess (proven
  necessary: from some hosts Cloudflare 403s plain `fetch` on its TLS/HTTP fingerprint alone, while
  an identical HTTP/1.1 curl request is accepted). The fallback is auto-OFF when a custom
  `fetchImpl` is injected, so the unit tests never shell out or touch the network. No dedicated
  unit test for the live path; exercised live by the HTTP-transport + haybarn tests.
- **`src/schema.ts` — typed Arrow schemas + batch builders.** Real typed columns
  (`Utf8`/`Float64`/`DateDay`), not JSON. Every calendar date is a real Arrow **DATE** (`DateDay`
  → DuckDB `DATE`, no timezone; a DATE cell is a JS `Date` at UTC midnight via `dateOrNull`).
  NOTE: dates are DATE, not TIMESTAMP (casting a UTC-midnight TIMESTAMPTZ `::DATE` shifts the day
  in non-UTC sessions). Percent columns carry a `_percent` suffix and hold **percent points**
  (`weight_percent` 7.38 = 7.38%). Non-percent numbers (`shares`, `market_value`) are unsuffixed.
- **`src/functions.ts`** — two `defineTableFunction`s: `makeProductsScan` (unlisted products
  backing scan) and `makeHoldingsScan` (`holdings`, LISTED, filterPushdown, SINGLE_VALUE
  partitions, queue/BoundStorage streaming). Each `make*` takes the `WisdomtreeClient` (`{get}`).
- **`src/catalog.ts` / `src/worker.ts`** — catalog descriptor (no `secretTypes`) and the entry
  that wires the real client into the functions.

## WisdomTree endpoint facts (why the design is what it is)

Two keyless HTML pages, both behind Cloudflare (browser UA + possibly the curl fallback):

1. **products** — `GET /us/products`. One ~0.8 MB HTML page; the lineup (~85 US ETFs) is embedded
   as `internalLink` product objects in the `__next_f` stream. Backs `products` and the ticker→slug
   resolution. No per-fund financials are embedded (expense ratio / AUM / NAV are lazy-loaded via a
   client API) — only ticker, name (`title`), category tiers, and slug.
2. **fund page** — `GET /us/products/{slug}` (slug e.g. `equity/dgrw`, from the catalog). ~2 MB
   HTML; the full constituent list is the `fundHoldingDetails` array in the `__next_f` stream.
   Current holdings only.

**Dates:** holdings carry a `dt` field as an ISO timestamp with React Server Components' `$D`
sentinel prefix (`"$D2026-07-08T00:00:00.000Z"`). `parseDate` strips `$D`, keeps the UTC calendar
day, and returns epoch SECONDS at UTC midnight → the Arrow `DateDay` path in schema.ts. There are
NO date ARGS (holdings is current-only; products takes no args).

## Fund identifier (`fund` / `fund_ticker`)

`resolveFund(get, fund)` matches the products-page catalog case-insensitively and returns
`{ ticker, slug }` (or null = not found). It does NOT throw (wisdomtree.ts is SDK-free). The
holdings scan resolves the whole target set to slugs in `onInit` via `slugMap`. The fund page URL
is `fundPageUrl(slug)`. Resolution is not cached beyond the 24 h products-page memo.

## Commands

```bash
bun install
bun test            # 28 tests: SDK-free driver + Arrow batch builders + live HTTP-transport E2E
bun run typecheck   # own-source only; scripts/typecheck.sh filters node_modules errors
./run_tests.sh      # haybarn SQLLogic E2E: worker under real DuckDB + community vgi ext
```

`run_tests.sh` sets `VGI_TEST_WORKER=bin/vgi-etf-wisdomtree-worker` +
`VGI_WORKER_CATALOG_NAME=wisdomtree` and runs `test/sql/*.test` (DESCRIBE-based schema asserts +
a few live-invariant asserts that hit WisdomTree). CI runs this, the reusable `ts-ci.yml`, and a
`vgi-lint` gate at `--fail-on info` (currently 100/100).

Typecheck must be a `bash scripts/typecheck.sh` file (not an inline package.json pipeline) —
`bun run` uses Bun's shell, which mishandles the `grep -v node_modules` filter. Pin
`typescript ^6.0.3` (5.x descends into SDK `.ts` source and reports external errors).

## Gotchas / conventions

- Emit `Date` (rich repr) for DATE columns via `batchFromColumns`; date fields go through
  `parseDate` (→ epoch seconds) then `dateOrNull`.
- `noUncheckedIndexedAccess` is on: guard array/string cell reads before use.
- vgi-lint rules to keep satisfied: catalog/schema descriptions must NOT enumerate the worker's own
  functions (VGI173); numeric column comments should state units/definition (VGI131 — e.g. "percent
  points", "Number of shares … held", "in USD"); every function needs an agent test task (VGI520 —
  products / holdings table / holdings() scan are covered in `catalog.ts` `vgi.agent_test_tasks`).
- Don't add a secret type; this worker is keyless by design.
- Don't add an `xlsx` dependency — holdings are embedded JSON, not a spreadsheet.
- Keep the `holdings` current-only contract: do NOT add `supportsTimeTravel` or an as-of arg.

## DuckDB (manual)

```sql
LOAD vgi;
ATTACH 'wisdomtree' AS wisdomtree (TYPE vgi, LOCATION '/path/to/vgi-etf-wisdomtree/bin/vgi-etf-wisdomtree-worker');
SELECT ticker, fund_name, asset_class FROM wisdomtree.products ORDER BY ticker LIMIT 10;
SELECT name, ticker, weight_percent FROM wisdomtree.holdings WHERE fund_ticker = 'DGRW' ORDER BY weight_percent DESC LIMIT 10;
```

// The WisdomTree driver — pure logic, no @query-farm SDK import. Every fetch* takes an injected
// `get(url) => Promise<string>` (an HTML page), so the archetype-proof tests drive it against an
// in-process fake and the worker wires the real HTTP client (client.ts). This module MUST NOT
// import from @query-farm/* — the unit tests import it without the SDK installed.
//
// Two KEYLESS WisdomTree data planes back the read paths, BOTH served as Next.js App-Router HTML
// pages (there is no public JSON API — WisdomTree's own Sanity GROQ endpoint is ACL-locked):
//
//   /us/products                       → products   (the whole US ETF lineup, ~85 funds)
//   /us/products/{slug}                → holdings    (a fund's full constituent list)
//
// Both pages stream their data as React Server Component payloads inside inline
// `self.__next_f.push([N,"…"])` script chunks. `extractNextF()` concatenates and unescapes those
// chunk strings back into one payload string; the parsers then pull the embedded JSON out of it:
//   • the products catalog is a set of `internalLink` product objects (ticker, title, category);
//   • a fund's holdings are the `fundHoldingDetails` array (one object per constituent, with
//     real values — securityName, securityTicker, shares, marketValueBase, wgt, figi).
//
// Every parser is defensive: a missing chunk / key / field degrades to an empty result or a null
// cell rather than throwing. `resolveFund` returns null (not a throw) on an unknown ticker so the
// caller (functions.ts) can raise a typed SDK error while this module stays SDK-free.
//
// DATES: the driver returns dates as epoch SECONDS at UTC midnight (number | null). The Arrow
// mapping to a real DATE column lives in schema.ts (keeping this module type/SDK-free).

export const WT_HOST = "https://www.wisdomtree.com";

/** The US ETF products page — one HTML page embedding the whole lineup. */
export const PRODUCTS_URL = `${WT_HOST}/us/products`;

/** A fund's product page URL, from its catalog slug (e.g. "equity/dgrw"). */
export function fundPageUrl(slug: string): string {
  return `${WT_HOST}/us/products/${slug.trim().replace(/^\/+/, "")}`;
}

// ── the __next_f (React Server Components) payload ──────────────────────────────

/**
 * Concatenate + unescape every `self.__next_f.push([N,"…"])` chunk in a Next.js App-Router page
 * back into one decoded payload string. Each push carries a JS string literal body; we wrap it in
 * quotes and JSON.parse to unescape. A malformed chunk is skipped, never thrown.
 */
export function extractNextF(html: string): string {
  const re = /self\.__next_f\.push\(\[\d+,"((?:[^"\\]|\\.)*)"\]\)/g;
  let m: RegExpExecArray | null;
  let out = "";
  while ((m = re.exec(html)) !== null) {
    try {
      out += JSON.parse('"' + m[1] + '"');
    } catch {
      // a chunk that isn't a clean string literal — skip it
    }
  }
  return out;
}

/**
 * Return the balanced JSON array text that starts at `open` (the index of a `[`), respecting
 * quoted strings and escapes so brackets inside string values don't confuse the scan. Null if
 * unbalanced.
 */
function balancedArray(s: string, open: number): string | null {
  if (s[open] !== "[") return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return s.slice(open, i + 1);
    }
  }
  return null;
}

/** Parse the JSON array value of `"key":[…]` out of a decoded payload, or [] if absent/broken. */
function jsonArrayForKey(payload: string, key: string): unknown[] {
  const needle = `"${key}":[`;
  const at = payload.indexOf(needle);
  if (at < 0) return [];
  const open = at + needle.length - 1; // index of the '['
  const text = balancedArray(payload, open);
  if (text == null) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── shared value coercion ───────────────────────────────────────────────────────

/** True for null/blank/"-"/"–"/all-whitespace strings. */
function isBlank(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" || t === "-" || t === "–";
  }
  return false;
}

const asStr = (v: unknown): string | null => (isBlank(v) ? null : String(v).trim());
const asNum = (v: unknown): number | null => {
  if (isBlank(v)) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// ── date parsing ────────────────────────────────────────────────────────────────

/** Build epoch SECONDS at UTC midnight from y/m/d, validating the parts round-trip. Null if bad. */
function ymdToEpoch(y: number, mo0: number, d: number): number | null {
  const ms = Date.UTC(y, mo0, d);
  if (Number.isNaN(ms)) return null;
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo0 || dt.getUTCDate() !== d) return null;
  return Math.floor(ms / 1000);
}

/**
 * Parse the date shapes WisdomTree uses → epoch SECONDS at UTC midnight (or null). The holdings
 * `dt` field is an ISO timestamp carrying React Server Components' `$D` sentinel prefix
 * (e.g. "$D2026-07-08T00:00:00.000Z"); a plain ISO date/timestamp is also accepted. Only the
 * calendar day is kept (UTC), never a time-of-day, so it maps to a real DATE.
 */
export function parseDate(v: unknown): number | null {
  if (isBlank(v)) return null;
  if (v instanceof Date) return ymdToEpoch(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
  const s = String(v).trim().replace(/^\$D/, "");
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return ymdToEpoch(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return null;
}

// ── products (the /us/products catalog) ─────────────────────────────────────────

export interface ProductRow {
  ticker: string | null;
  fundName: string | null;
  assetClass: string | null;
  category: string | null;
  subCategory: string | null;
  productPageUrl: string | null;
}

/** A JSON string-or-null token like `"Domestic Equity"` / `null` → the string or null. */
function jsonTokenStr(token: string | undefined): string | null {
  if (token == null) return null;
  const t = token.trim();
  if (t === "null" || t === "") return null;
  try {
    const v = JSON.parse(t);
    return typeof v === "string" ? (isBlank(v) ? null : v.trim()) : null;
  } catch {
    return null;
  }
}

/**
 * Parse the products catalog out of the decoded /us/products payload. Each fund is a Sanity
 * `internalLink` product object; its `slug`/`ticker`/`title` sit together at the tail of the
 * object, so we anchor on that trio and read the category tiers from the short window preceding
 * it (Sanity serializes object keys alphabetically, so the tiers come earlier in the SAME
 * object). Deduped by ticker. `ticker`, when non-empty, narrows to that one fund.
 */
export function parseProducts(payload: string, ticker = ""): ProductRow[] {
  const wantTicker = ticker.trim().toUpperCase();
  const re =
    /"slug":\{"current":"([^"]+)"\},"ticker":"([^"]+)","title":"((?:[^"\\]|\\.)*)"/g;
  const seen = new Set<string>();
  const rows: ProductRow[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(payload)) !== null) {
    const slug = m[1]!;
    const tk = m[2]!.trim().toUpperCase();
    if (!tk || seen.has(tk)) continue;
    if (wantTicker && tk !== wantTicker) continue;
    seen.add(tk);
    let title: string | null = null;
    try {
      title = asStr(JSON.parse('"' + m[3]! + '"'));
    } catch {
      title = null;
    }
    // Category tiers live just before the slug, in the same product object.
    const window = payload.slice(Math.max(0, m.index - 900), m.index);
    const tier = (n: 1 | 2 | 3): string | null => {
      const tm = new RegExp(`"fundCategoryTier${n}":(null|"(?:[^"\\\\]|\\\\.)*")`, "g");
      let last: RegExpExecArray | null = null;
      let x: RegExpExecArray | null;
      while ((x = tm.exec(window)) !== null) last = x;
      return last ? jsonTokenStr(last[1]) : null;
    };
    rows.push({
      ticker: m[2]!.trim().toUpperCase(),
      fundName: title,
      assetClass: tier(1),
      category: tier(2),
      subCategory: tier(3),
      productPageUrl: `/us/products/${slug}`,
    });
  }
  rows.sort((a, b) => (a.ticker ?? "").localeCompare(b.ticker ?? ""));
  return rows;
}

/** A fund's catalog slug (e.g. "equity/dgrw"), keyed by ticker. Internal — not an output column. */
export function slugMap(payload: string): Map<string, string> {
  const re = /"slug":\{"current":"([^"]+)"\},"ticker":"([^"]+)","title":/g;
  const out = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(payload)) !== null) {
    const tk = m[2]!.trim().toUpperCase();
    if (tk && !out.has(tk)) out.set(tk, m[1]!);
  }
  return out;
}

export async function fetchProducts(
  get: (url: string) => Promise<string>,
  ticker = "",
): Promise<ProductRow[]> {
  return parseProducts(extractNextF(await get(PRODUCTS_URL)), ticker);
}

// ── fund resolution (ticker → catalog slug) ─────────────────────────────────────

export interface ResolvedFund {
  ticker: string;
  slug: string;
}

/**
 * Resolve a `fund` argument to its canonical ticker + catalog slug by matching the products page
 * (case-insensitive). Returns null when the ticker isn't in the WisdomTree US lineup (the caller
 * raises a typed ArgumentValidationError — this module stays SDK-free). One products-page fetch.
 */
export async function resolveFund(
  get: (url: string) => Promise<string>,
  fund: string,
): Promise<ResolvedFund | null> {
  const wanted = fund.trim().toUpperCase();
  if (!wanted) return null;
  const slugs = slugMap(extractNextF(await get(PRODUCTS_URL)));
  const slug = slugs.get(wanted);
  return slug ? { ticker: wanted, slug } : null;
}

// ── holdings (the fundHoldingDetails array on a fund page) ───────────────────────

export interface HoldingRow {
  /** The fund's ticker — the partition key (constant per fund; distinct from the constituent `ticker`). */
  fundTicker: string | null;
  asOfDate: number | null;
  name: string | null;
  /** Constituent ticker (exchange suffix stripped; null for cash / FX rows). */
  ticker: string | null;
  figi: string | null;
  /** Asset group: "EQ" (equity), "CA" (cash), etc. */
  assetGroup: string | null;
  weightPercent: number | null;
  shares: number | null;
  marketValue: number | null;
}

/**
 * Strip a trailing 2-letter Bloomberg exchange code from a security ticker
 * ("NVDA UQ" → "NVDA", "MSFT US" → "MSFT", "GOOG" → "GOOG"). Blank → null.
 */
function cleanTicker(v: unknown): string | null {
  const s = asStr(v);
  if (s == null) return null;
  const m = /^(\S+)\s+[A-Z]{2}$/.exec(s);
  return m ? m[1]! : s;
}

/**
 * Parse a fund's holdings out of the decoded fund-page payload — the `fundHoldingDetails` array,
 * one object per constituent. Rows are sorted by weight desc (NULLS last) so `… LIMIT n` returns
 * the top holdings without an ORDER BY. `wgt` is a fraction (0–1) → percent points (×100).
 */
export function parseHoldings(payload: string, fundTicker: string | null): HoldingRow[] {
  const items = jsonArrayForKey(payload, "fundHoldingDetails");
  const rows: HoldingRow[] = [];
  for (const it of items) {
    if (it == null || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const name = asStr(o.securityName);
    if (name == null) continue;
    const wgt = asNum(o.wgt);
    rows.push({
      fundTicker,
      asOfDate: parseDate(o.dt),
      name,
      ticker: cleanTicker(o.securityTicker),
      figi: asStr(o.figi),
      assetGroup: asStr(o.assetGroup),
      weightPercent: wgt == null ? null : wgt * 100,
      shares: asNum(o.shares),
      marketValue: asNum(o.marketValueBase),
    });
  }
  rows.sort((a, b) => (b.weightPercent ?? -Infinity) - (a.weightPercent ?? -Infinity));
  return rows;
}

/**
 * Detailed holdings for one fund (its current published constituent list — WisdomTree embeds only
 * current holdings, so there is no as-of/time-travel coordinate). Returns [] for a fund page with
 * no embedded holdings.
 */
export async function fetchHoldings(
  get: (url: string) => Promise<string>,
  fund: ResolvedFund,
): Promise<HoldingRow[]> {
  const html = await get(fundPageUrl(fund.slug));
  return parseHoldings(extractNextF(html), fund.ticker.toUpperCase());
}

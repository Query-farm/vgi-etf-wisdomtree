// A tiny in-process fake of the WisdomTree website — enough to prove the driver: it records every
// requested URL (so a test can assert the wire contract) and returns canned HTML pages shaped like
// the real Next.js App-Router pages, with the fund data embedded in `self.__next_f.push([…])`
// chunks exactly as WisdomTree serves it. No network.
//
// The fixtures below are trimmed but faithful slices of the REAL /us/products and /us/products/
// {slug} pages (the product `internalLink` objects and the `fundHoldingDetails` array), so the
// full parse path — extractNextF → parseProducts / parseHoldings — is exercised end to end.

import { PRODUCTS_URL, fundPageUrl } from "../src/wisdomtree.js";

export class FakeWisdomtree {
  /** Every URL this fake was asked for, in order. */
  readonly calls: string[] = [];

  constructor(private readonly page: (url: string) => string) {}

  get = async (url: string): Promise<string> => {
    this.calls.push(url);
    return this.page(url);
  };

  /** Route the products page and each fund page (by slug) to the right embedded payload. */
  static site(): FakeWisdomtree {
    return new FakeWisdomtree((url) => {
      if (url === PRODUCTS_URL) return nextPage(productsPayload());
      for (const [slug, payload] of Object.entries(HOLDINGS_BY_SLUG)) {
        if (url === fundPageUrl(slug)) return nextPage(payload);
      }
      throw new Error(`404 for ${url}`);
    });
  }
}

/** Wrap a decoded RSC payload string in a minimal HTML page as two __next_f chunks (proves concat). */
export function nextPage(payload: string): string {
  const mid = Math.floor(payload.length / 2);
  const push = (s: string) => `<script>self.__next_f.push([1,${JSON.stringify(s)}])</script>`;
  return `<!doctype html><html><body>${push(payload.slice(0, mid))}${push(payload.slice(mid))}</body></html>`;
}

// ── products payload (the /us/products internalLink product objects) ─────────────

const q = (v: string | null): string => (v == null ? "null" : JSON.stringify(v));

function productObject(
  id: string,
  tier1: string,
  tier2: string | null,
  tier3: string | null,
  slug: string,
  ticker: string,
  title: string,
): string {
  // Faithful to Sanity's serialization: alphabetical keys, a nested policies[rules[]] array
  // between the category tiers and the slug/ticker/title trio the parser anchors on.
  return (
    `{"_key":"k-${ticker}","productLinks":[{"_key":"link-${ticker}","_type":"productLinks",` +
    `"blank":false,"internalLink":{"_id":${q(id)},"_type":"product","cleanTicker":null,` +
    `"fundCategoryTier1":${q(tier1)},"fundCategoryTier2":${q(tier2)},"fundCategoryTier3":${q(tier3)},` +
    `"nameWithoutWT":null,"overrideTicker":null,"policies":[{"_id":"pol-1","key":"pub",` +
    `"name":"US Allow All Audiences","rules":[{"audiences":[],"countries":[],"effect":"allow",` +
    `"key":"allow-public","name":"Allow public"}]}],"slug":{"current":${q(slug)}},` +
    `"ticker":${q(ticker)},"title":${q(title)}},"text":${q(ticker)},"type":"internal"}]}`
  );
}

/** Three funds spanning asset classes; DGRW and EPS also have holdings pages below. */
export function productsPayload(): string {
  const funds = [
    productObject("1001798.product", "Domestic Equity", "Large Cap Core", null, "equity/dgrw", "DGRW", "U.S. Quality Dividend Growth Fund"),
    productObject("1000516.product", "Domestic Equity", "Large Cap Core", null, "equity/eps", "EPS", "U.S. LargeCap Fund"),
    productObject("1000123.product", "Fixed Income", "Strategic Core/Core Plus", null, "fixed-income/aggy", "AGGY", "Yield Enhanced U.S. Aggregate Bond Fund"),
  ];
  return `[["navData"],{"products":[${funds.join(",")}]}]`;
}

// ── holdings payloads (a fund page's fundHoldingDetails array) ────────────────────

function holding(
  ticker: string | null,
  name: string,
  assetGroup: string,
  shares: number,
  mv: number,
  wgt: number,
  figi: string,
): string {
  return (
    `{"dt":"$D2026-07-08T00:00:00.000Z","wtClassID":1000521,"fundTicker":"DGRW",` +
    `"assetGroup":${q(assetGroup)},"securityTicker":${q(ticker)},"securityName":${q(name)},` +
    `"shares":${shares},"marketValueBase":${mv},"wgt":${wgt},"figi":${q(figi)},` +
    `"checkSumWgtAssetGroup":0.999,"checkSumWgtEntity":1}`
  );
}

/** A DGRW-shaped holdings payload: equity rows (intentionally NOT weight-ordered) + a cash row. */
export function dgrwHoldingsPayload(): string {
  const rows = [
    holding("AAPL UQ", "Apple Inc", "EQ", 2217846, 695050757.94, 0.0417, "BBG000B9XRY4"),
    holding("NVDA UQ", "Nvidia Corp", "EQ", 6590518, 1345256534.16, 0.0808, "BBG000BBJQV0"),
    holding("GOOG", "Alphabet Inc", "EQ", 100000, 20000000, 0.012, "BBG009S3NB30"),
    holding(null, "US DOLLAR", "CA", 3097962, 3097962.25, 0.0002, "CASH-US DOLLAR"),
  ];
  // A leading classification array (ignored by the parser) precedes fundHoldingDetails on the real page.
  return `{"rankClassification":[{"dt":"2026-07-07","pctWeight":0.5}],"fundHoldingDetails":[${rows.join(",")}]}`;
}

/** An EPS-shaped payload with two rows (used for the multi-fund fan-out tests). */
export function epsHoldingsPayload(): string {
  const rows = [
    holding("MSFT US", "Microsoft Corp", "EQ", 2556928, 980172779.52, 0.0588, "BBG000BPH459"),
    holding("AVGO US", "Broadcom Inc", "EQ", 500000, 400000000, 0.03, "BBG000C2V3D6"),
  ];
  return `{"fundHoldingDetails":[${rows.join(",")}]}`;
}

export const HOLDINGS_BY_SLUG: Record<string, string> = {
  "equity/dgrw": dgrwHoldingsPayload(),
  "equity/eps": epsHoldingsPayload(),
  // fixed-income/aggy has NO embedded holdings (proves the "skip a fund with no holdings" path).
  "fixed-income/aggy": `{"someOtherKey":[]}`,
};

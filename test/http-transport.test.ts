// HTTP-transport smoke test.
//
// Every other test drives the worker over the *stdio* transport (DuckDB spawns
// `bin/vgi-etf-wisdomtree-worker` and talks to it over stdin/stdout; the haybarn suite exercises
// that). This one stands the SAME registry + catalog up behind the stateless HTTP handler
// (`createVgiFetch`, the Cloudflare/Bun HTTP seam), serves it with `Bun.serve`, and drives it
// end-to-end with the high-level `VgiClient` over `httpConnect`.
//
// It proves the design claim — that the `{done}` function state is serializable enough to
// round-trip through a stateless HTTP request (state is carried in a signed token between
// requests, not held in memory).
//
// Coverage:
//   - protocol handshake over HTTP (catalogs / attach)               [network-free]
//   - the products/holdings tables are exposed over HTTP             [network-free]
//   - a full products scan round-trips over HTTP                     [live: WisdomTree]
//
// The final scan hits WisdomTree live (like the haybarn live-invariant asserts) — fine for an
// egress connector. Schema columns are deterministic; only row content is live.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { createVgiFetch } from "@query-farm/vgi/worker-cf";
import { FunctionRegistry, ReadOnlyCatalogInterface, VgiClient, Arguments } from "@query-farm/vgi";
import { httpConnect } from "@query-farm/vgi-rpc";
import { makeProductsScan, makeHoldingsScan } from "../src/functions.js";
import { makeCatalog } from "../src/catalog.js";
import { makeWisdomtreeGet } from "../src/client.js";
import { fetchProducts } from "../src/wisdomtree.js";

const PREFIX = "/vgi";
// Static 32-byte HMAC key — the HTTP handler signs state tokens with it.
const SIGNING_KEY = new Uint8Array(32).fill(7);

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  const client = makeWisdomtreeGet();
  const functions: never[] = [];
  const productsScan = makeProductsScan(client);
  const holdingsScan = makeHoldingsScan(client);
  const registry = new FunctionRegistry();
  registry.register(productsScan);
  registry.register(holdingsScan);
  const catalogInterface = new ReadOnlyCatalogInterface(
    makeCatalog(functions, productsScan, holdingsScan),
    registry,
  );

  const fetch = createVgiFetch({
    protocol: { registry, catalogInterface },
    signingKey: SIGNING_KEY,
    prefix: PREFIX,
  });

  server = Bun.serve({ port: 0, fetch });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

test("catalog is discoverable over HTTP", async () => {
  const rpc = httpConnect(baseUrl, { prefix: PREFIX });
  try {
    const client = new VgiClient(rpc);
    expect(await client.catalogs()).toContain("wisdomtree");
  } finally {
    rpc.close();
  }
});

test("the products/holdings tables (and the holdings scan) are exposed over HTTP", async () => {
  const rpc = httpConnect(baseUrl, { prefix: PREFIX });
  try {
    const client = new VgiClient(rpc);
    const attach = await client.catalogAttach("wisdomtree");
    const fns = await client.schemaContentsFunctions(attach.attach_opaque_data, "main", "TABLE_FUNCTION");
    // The holdings backing scan is listed under the same name as the holdings table (required so
    // the extension pushes the ticker filter into the holdings table); products' scan stays unlisted.
    expect(fns.map((f) => f.name).sort()).toEqual(["holdings"]);
    // products and holdings are base TABLES.
    const tables = await client.schemaContentsTables(attach.attach_opaque_data, "main");
    expect(tables.map((t) => t.name).sort()).toEqual(["holdings", "products"]);
  } finally {
    rpc.close();
  }
});

test("products table scan round-trips over HTTP (live)", async () => {
  // Skip when WisdomTree's Cloudflare front walls this IP (e.g. GitHub CI runners): probe with the
  // worker's own driver+transport; if the lineup isn't reachable, skip the live scan assertions.
  // The deterministic schema/protocol tests above and the fake-injected driver unit tests still run.
  const probe = await fetchProducts(makeWisdomtreeGet().get).catch(() => []);
  if (probe.length <= 50) {
    console.warn(`[skip] WisdomTree unreachable/blocked (${probe.length} funds) — skipping live scan assertions`);
    return;
  }

  const rpc = httpConnect(baseUrl, { prefix: PREFIX });
  try {
    const client = new VgiClient(rpc);
    const attach = await client.catalogAttach("wisdomtree");

    const rows: Record<string, any>[] = [];
    // Scan via the table's backing function (registered as "products").
    for await (const batch of client.tableFunctionRows({
      functionName: "products",
      arguments: new Arguments([], new Map()),
      attachOpaqueData: attach.attach_opaque_data,
    })) {
      rows.push(...batch);
    }

    // Live: WisdomTree lists ~85 US ETFs.
    expect(rows.length).toBeGreaterThan(50);
    // Deterministic: the typed schema round-tripped intact over HTTP.
    const cols = Object.keys(rows[0]!).sort();
    expect(cols).toContain("ticker");
    expect(cols).toContain("fund_name");
    expect(cols).toContain("asset_class");
    // Live invariant: DGRW is in the ETF list.
    expect(rows.some((r) => r.ticker === "DGRW")).toBe(true);
  } finally {
    rpc.close();
  }
}, 30000);

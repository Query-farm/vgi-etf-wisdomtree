// vgi-etf-wisdomtree stdio worker entry. DuckDB spawns this and ATTACHes it:
//   LOAD vgi;
//   ATTACH 'wisdomtree' AS wisdomtree (TYPE vgi, LOCATION '/path/to/vgi-etf-wisdomtree/bin/vgi-etf-wisdomtree-worker');
//   SELECT * FROM wisdomtree.products ORDER BY ticker LIMIT 10;
//   SELECT * FROM wisdomtree.holdings WHERE fund_ticker = 'DGRW' ORDER BY weight_percent DESC LIMIT 10;
//
// Keyless: no CREATE SECRET is needed. `products` and `holdings` are base TABLES (backed by scan
// functions). All take the injected HTTP client (client.ts).

import { Worker, ReadOnlyCatalogInterface, FunctionRegistry } from "@query-farm/vgi";
import { makeWisdomtreeGet } from "./client.js";
import { makeProductsScan, makeHoldingsScan } from "./functions.js";
import { makeCatalog } from "./catalog.js";

const client = makeWisdomtreeGet();

// No callable table functions — products and holdings are base tables.
const functions = [] as const;

// Backing scans for the base tables: registered so scan RPCs resolve. products' scan stays
// unlisted (exposed only as the `products` table); holdings' scan is LISTED (in makeCatalog) so
// the extension can push the fund_ticker filter into the `holdings` table.
const productsScan = makeProductsScan(client);
const holdingsScan = makeHoldingsScan(client);

const registry = new FunctionRegistry();
registry.register(productsScan);
registry.register(holdingsScan);

const catalogInterface = new ReadOnlyCatalogInterface(
  makeCatalog([...functions], productsScan, holdingsScan),
  registry,
);

// `functions` for the Worker is the full set the registry serves (the table scans).
new Worker({ functions: [productsScan, holdingsScan], catalogInterface }).run();

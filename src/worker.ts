// vgi-etf-wisdomtree stdio worker entry. DuckDB spawns this and ATTACHes it:
//   LOAD vgi;
//   ATTACH 'wisdomtree' AS wisdomtree (TYPE vgi, LOCATION '/path/to/vgi-etf-wisdomtree/bin/vgi-etf-wisdomtree-worker');
//   SELECT * FROM wisdomtree.products ORDER BY ticker LIMIT 10;
//   SELECT * FROM wisdomtree.holdings WHERE fund_ticker = 'DGRW' ORDER BY weight_percent DESC LIMIT 10;
//
// What this worker serves is defined once in src/parts.ts and shared with the
// HTTP entrypoint (scripts/serve.ts).

import { Worker } from "@query-farm/vgi";
import { makeWorkerParts } from "./parts.js";

const { servedFunctions, catalogInterface } = makeWorkerParts();

// `functions` for the Worker is the full set the registry serves (incl. the table scans).
new Worker({ functions: servedFunctions, catalogInterface }).run();

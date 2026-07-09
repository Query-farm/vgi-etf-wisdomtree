#!/usr/bin/env bash
# Run the SQLLogic (haybarn) suite in test/sql/ against the TypeScript worker, using the
# haybarn DuckDB distribution's unittest runner (which loads the `vgi` extension from the
# community repository).
#
# Prerequisites (one-time):
#   uv tool install haybarn-unittest                      # the DuckDB unittest binary
#   echo "INSTALL vgi FROM community;" | uvx haybarn-cli  # install the vgi extension
#   bun install                                           # the worker's deps
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

UNITTEST="${VGI_UNITTEST:-$(command -v haybarn-unittest || true)}"
if [[ -z "$UNITTEST" || ! -x "$UNITTEST" ]]; then
    echo "ERROR: haybarn-unittest not found. Install it with:" >&2
    echo "       uv tool install haybarn-unittest" >&2
    exit 1
fi

# Ensure the vgi community extension is installed for this haybarn version.
if ! echo "LOAD vgi;" | uvx haybarn-cli >/dev/null 2>&1; then
    echo "==> Installing vgi extension from community repository"
    echo "INSTALL vgi FROM community;" | uvx haybarn-cli
fi

# NOTE: the last arg is a Catch2 test-name filter, not a shell glob. Catch2 only honors a
# trailing `*` wildcard, so use `test/sql/*` (not `test/sql/*.test`).
WORKER="$REPO_ROOT/bin/vgi-etf-wisdomtree-worker"
TEST_GLOB="${1:-test/sql/*}"

# --- Reachability gate for the LIVE invariants (products_live.test / holdings_live.test) ---
# WisdomTree is fronted by Cloudflare, which walls some datacenter IPs (e.g. GitHub CI runners) on
# BOTH a plain fetch AND the curl --http1.1 fallback. Probe with the worker's OWN driver+transport:
# if it returns the product lineup, set WT_LIVE=1 so the *_live.test files run; otherwise skip them
# (require-env WT_LIVE) and run only the deterministic schema asserts — so CI is green anywhere while
# the live invariants still gate whenever the site IS reachable (locally, a residential runner, …).
WT_LIVE=""
if command -v bun >/dev/null 2>&1; then
    echo "==> Probing WisdomTree reachability (its Cloudflare front may wall this IP)…"
    N=$(bun -e 'import {makeWisdomtreeGet} from "./src/client.ts"; import {fetchProducts} from "./src/wisdomtree.ts"; try { const r = await fetchProducts(makeWisdomtreeGet().get); console.log(r.length); } catch { console.log(0); }' 2>/dev/null || echo 0)
    N=${N//[^0-9]/}; N=${N:-0}
    if [ "$N" -gt 50 ]; then
        echo "    reachable — $N funds; running LIVE invariants."
        WT_LIVE=1
    else
        echo "    unreachable/blocked (got $N funds) — SKIPPING live invariants (schema asserts still run)."
    fi
else
    echo "==> bun not found; skipping reachability probe (live invariants will be skipped)."
fi

echo "==> Running SQLLogic tests"
echo "    worker:   $WORKER"
echo "    unittest: $UNITTEST"
echo "    tests:    $TEST_GLOB"
echo "    WT_LIVE:  ${WT_LIVE:-<unset — live invariants skipped>}"

env VGI_TEST_WORKER="$WORKER" \
    VGI_WORKER_CATALOG_NAME="wisdomtree" \
    ${WT_LIVE:+WT_LIVE="$WT_LIVE"} \
    "$UNITTEST" --test-dir "$REPO_ROOT" "$TEST_GLOB"

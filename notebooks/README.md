# Executed WisdomTree rounding walkthrough

[What gets lost when holdings weights are rounded?](01_measure_weight_rounding_error.ipynb) retrieves DGRW's high-precision reported weights and USD market values through the real VGI worker, checks the ratios they imply, and deliberately rounds the weights in SQL. It measures the resulting rowwise denominator error and explicitly counts ratios made undefined by zero-rounded weights. The source data are real; rounding is a constructed experiment, not a claim about issuer data quality or investment suitability.

## Install and run from this directory

Prerequisites: [uv](https://docs.astral.sh/uv/), Git, [Bun](https://bun.sh/), Python 3.13 or 3.14, and network access on first launch. The upstream live client can use the system `curl` for its existing transport behavior. No account or API credential is needed. Copy all of `notebooks/` to run without the worker repository.

```sh
cd notebooks
uv sync --frozen
uv run --frozen python execute.py --timeout 180
```

The separate environment pins published Haybarn `2.0.0rc11`. The runner uses its own interpreter and a temporary kernel with notebook-directory cwd. It saves outputs atomically only after success. Root dependencies, locks and source are not discovered or modified; a failure preserves the successful notebook.

For an interactive editor, register and select this kernel:

```sh
uv run --frozen python -m ipykernel install --user --name vgi-wisdomtree-notebooks --display-name 'Python (WisdomTree notebooks)'
```

Keep cwd at `notebooks/`. Parameters and analytical SQL remain expanded; Python configuration, plotting and cleanup are folded. The local branding assets are official unchanged images.

## Precision experiment and live mode

`WEIGHT_DECIMALS=2` means a rounding increment of 0.01 percentage points of reported assets. It accepts integers 0–4; change only this value to 1 for a ten-times coarser increment:

```sh
uv run --frozen python execute.py --timeout 180 --parameters '{"WEIGHT_DECIMALS":1}' --output-dir artifacts/one-decimal
```

Reset to 2 for the default. Overrides require a separate output directory. Successful experiment copies receive the local assets, recordings, helper, launcher, transport adapter, README and environment files. Generated caches, request audits, logs, chart extracts and experiment copies are ignored.

`DATA_MODE="recorded"` uses three official responses captured 2026-11-14 at 07:04:41–43 UTC; the holdings are effective 2026-11-13. `DATA_MODE="live"` calls current official endpoints for the same fund and updates dates and labels:

```sh
uv run --frozen python execute.py --timeout 180 --parameters '{"DATA_MODE":"live"}' --output-dir artifacts/live
```

No past-date parameter exists. Capture/execution clocks are UTC; effective dates are SQL DATE values. Independent responses are not an atomic snapshot. The upstream holdings scan can skip failed/empty funds, so the notebook explicitly rejects absent DGRW or unusable inputs. Live failures never trigger a recorded fallback.

## Why this remote source revision is pinned

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'wisdomtree' (TYPE vgi, LOCATION 'bash launch_worker.sh');
```

The tested native `github-auto://Query-farm/vgi-etf-wisdomtree@v0.4.0` release attaches but returns zero DGRW holdings against the current website: it expects an embedded `fundHoldingDetails` array. The current site instead exposes the array via a public JSON follow-up route. We do not substitute fabricated output or claim that release passes.

`launch_worker.sh` fetches immutable remote revision `c66095fef6a7f778ca4f31e9b9dfb62075aedd61` from `https://github.com/Query-farm/vgi-etf-wisdomtree`, which already supports the follow-up route, and installs that revision's frozen Bun lock. The launcher checks the cached Git revision and tracked source and serializes clone/install across concurrent VGI process starts. Bun 1.3.14 was used in validation. No engine is built and no worker source is changed.

The small adapter wires the unchanged function factories/catalog through the existing client fetch seam. Recorded mode verifies the manifest hashes and supplies exact saved text; live mode uses the pinned normal HTTP client. HTML extraction, entity resolution, follow-up retrieval, JSON parsing, source-fraction-to-percent conversion, filter pushdown and Arrow output remain in the actual worker. The default audits exactly catalog → fund HTML → holdings JSON. The only local worker-related code is the adapter and launcher, both notebook companions.

When upgrading the pin, first verify the remote revision and data shape through published Haybarn, then rerun defaults, precision experiment, live mode and all checks. Source gates below apply to the recorded current revision, not the older v0.4.0 binary.

## Provenance, arithmetic and limits

[Recording notes](recordings/README.md) and the [manifest](recordings/manifest.json) record exact source URLs, UTC capture times, decoded-text byte counts and hashes. Responses are real, complete saved text, not synthetic portfolios or silently refreshed fixtures. Provider content remains separate from the repository's code license.

The worker maps source weight fraction `wgt` to percentage points by multiplying by 100. For USD market value V and positive percentage-point weight w, `D=100*V/w`. This implied denominator is an internal consistency diagnostic, not an independently verified official net-asset figure. Rounding uses SQL `round` on the DOUBLE percentage-point input. A rounded positive weight yields `D_rounded`; relative change is `100*(D_rounded/D-1)`, independently equal to `100*(w/w_rounded-1)`. Zero-rounded weights have undefined ratios and remain explicitly counted.

Error categories compare each row to its own unrounded ratio. Their weight shares use original eligible weights; no surviving weights are renormalized after zero-rounding. Unknown, zero and negative source inputs are shown separately, with overlapping diagnostic counts disclosed. The logarithmic scatter axis contains only positive original weights; the undefined cases appear in the coverage chart. Python presents results, while SQL owns all ratios, rounding, categorization and validation.

## Validation

Verified through published Haybarn on macOS arm64:

- Default, one-decimal experiment and complete live mode run from a copied notebooks-only directory in 5.3 s, 5.1 s and 6.1 s. Each has 13 code cells, six SQL cells, two charts, ten SQL invariants, and a three-request audit in recorded mode. All six charts were inspected.
- All 199 recorded rows have positive known weight/value pairs, effective 2026-11-13. Their original implied-denominator median is USD 17.536586 billion; the range is about 4.35e-14% of the median, consistent at floating-point precision. This is not an independently sourced official net-asset figure.
- Coarsening two→one decimal places creates 2→58 undefined ratios, representing 0.008%→1.379% of original eligible weight. The largest finite rowwise error changes from 45.40% to 49.17%. Original observations and unrounded ratios remain fixed. Live mode returned the same date and values during validation; future results can change.
- All three runner guards pass and preserve the successful source. Default/experiment/live notebooks pass structural review; notebook Ruff lint/format, launcher shell syntax, official branding and stored response hashes pass.
- Source checks for the pinned remote revision pass: 32 Bun tests / 84 expectations, own-source TypeScript check, 23 SQL assertions in four cases, and metadata 100 L2 with zero findings at fail-on-info. Metadata execution was enabled; external-link and paid AI passes were disabled. The older v0.4.0 native empty-result limitation is documented above, not reported as passing holdings validation.

Root source and `bun.lock` are unchanged. Ignored `artifacts/` contains logs, extracted charts, request audits and the separate experiment/live notebooks.

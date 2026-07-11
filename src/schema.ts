// Arrow output schemas + row→batch mapping for the products / holdings surfaces.
//
// WisdomTree data has a STABLE, known shape, so we emit real typed columns (not a single JSON
// string): Utf8 identifiers/names, Float64 weights/values, and a real Arrow DATE (Date32) for
// every calendar date. `batchFromColumns` defaults to the "rich" representation, so a DATE cell
// is a JS `Date` (at UTC midnight). Percent-valued columns carry a `_percent` suffix and hold
// percent-magnitude numbers (e.g. 7.38 = 7.38%).

import { Schema, Field, Utf8, Float64, DateDay } from "@query-farm/apache-arrow";
import { batchFromColumns } from "@query-farm/vgi";
import type { ProductRow, HoldingRow } from "./wisdomtree.js";

const f = (name: string, type: ConstructorParameters<typeof Field>[1]) => new Field(name, type, true);
const date = () => new DateDay();

/**
 * A hive-style partition-column field: carries `vgi.partition_column = "true"` so the DuckDB
 * binder treats it as a partition key. `holdings` is partitioned on `fund_ticker` — each scanned
 * fund is one SINGLE_VALUE partition (see makeHoldingsScan). Mirrors vgi's `partition_field`.
 */
const partitionField = (name: string, type: ConstructorParameters<typeof Field>[1]) =>
  new Field(name, type, true, new Map([["vgi.partition_column", "true"]]));

/** Map an Arrow field type to the DuckDB type name shown in docs. */
function duckdbType(type: unknown): string {
  const n = (type as { constructor?: { name?: string } })?.constructor?.name ?? "";
  if (n.startsWith("Utf8")) return "VARCHAR";
  if (n.startsWith("Float")) return "DOUBLE";
  if (n.startsWith("Int") || n.startsWith("Uint")) return "BIGINT";
  if (n.startsWith("Date")) return "DATE";
  return "VARCHAR";
}

/**
 * Build the `vgi.result_columns_schema` tag value (a JSON array of {name, type, description})
 * for a static result schema, DRY from the Arrow schema + a name→description map.
 */
export function resultColumnsSchema(schema: Schema, descriptions: Record<string, string>): string {
  return JSON.stringify(
    schema.fields.map((field) => ({
      name: field.name,
      type: duckdbType(field.type),
      description: descriptions[field.name] ?? field.name,
    })),
  );
}

/** JS Date | null for a DATE (Date32) cell from epoch SECONDS at UTC midnight. */
const dateOrNull = (sec: number | null): Date | null => (sec == null ? null : new Date(sec * 1000));

// ── products ──────────────────────────────────────────────────────────────────

export function productsSchema(): Schema {
  return new Schema([
    f("ticker", new Utf8()),
    f("fund_name", new Utf8()),
    f("asset_class", new Utf8()),
    f("category", new Utf8()),
    f("sub_category", new Utf8()),
    f("product_page_url", new Utf8()),
  ]);
}

export function productsBatch(schema: Schema, rows: ProductRow[]) {
  return batchFromColumns(
    {
      ticker: rows.map((r) => r.ticker),
      fund_name: rows.map((r) => r.fundName),
      asset_class: rows.map((r) => r.assetClass),
      category: rows.map((r) => r.category),
      sub_category: rows.map((r) => r.subCategory),
      product_page_url: rows.map((r) => r.productPageUrl),
    },
    schema,
  );
}

// ── holdings ────────────────────────────────────────────────────────────────

export function holdingsSchema(): Schema {
  return new Schema([
    // fund_ticker is the hive partition key: the holdings scan emits one SINGLE_VALUE partition per fund.
    partitionField("fund_ticker", new Utf8()),
    f("as_of_date", date()),
    f("name", new Utf8()),
    f("ticker", new Utf8()),
    f("figi", new Utf8()),
    f("asset_group", new Utf8()),
    f("weight_percent", new Float64()),
    f("shares", new Float64()),
    f("market_value", new Float64()),
  ]);
}

export function holdingsBatch(schema: Schema, rows: HoldingRow[]) {
  return batchFromColumns(
    {
      fund_ticker: rows.map((r) => r.fundTicker),
      as_of_date: rows.map((r) => dateOrNull(r.asOfDate)),
      name: rows.map((r) => r.name),
      ticker: rows.map((r) => r.ticker),
      figi: rows.map((r) => r.figi),
      asset_group: rows.map((r) => r.assetGroup),
      weight_percent: rows.map((r) => r.weightPercent),
      shares: rows.map((r) => r.shares),
      market_value: rows.map((r) => r.marketValue),
    },
    schema,
  );
}

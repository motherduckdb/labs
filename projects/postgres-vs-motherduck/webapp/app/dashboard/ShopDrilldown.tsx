"use client";

/**
 * Customer-facing per-shop drill-down. The cleanest path is an embedded MotherDuck
 * Dive scoped to one shop_id — the heavy filtering/aggregation runs in the user's
 * browser via DuckDB-Wasm under the hood, so drill-downs are instant and never hit
 * your server. Drop the Dive's embed URL in NEXT_PUBLIC_DIVE_URL.
 *
 * (If you'd rather hand the browser a scoped Parquet file and run DuckDB-Wasm
 * yourself, generate it server-side with `COPY (SELECT … WHERE shop_id = $1) TO …`
 * and load it with @duckdb/duckdb-wasm — see the chapter's note.)
 */
export function ShopDrilldown({ shopId }: { shopId: number }) {
  const base = process.env.NEXT_PUBLIC_DIVE_URL;
  if (!base) {
    return <p style={{ color: "#999" }}>Set NEXT_PUBLIC_DIVE_URL to embed the per-shop Dive.</p>;
  }
  const src = `${base}${base.includes("?") ? "&" : "?"}shop_id=${shopId}`;
  return (
    <iframe
      title={`Shop ${shopId} analytics`}
      src={src}
      style={{ width: "100%", height: 480, border: "1px solid #eee", borderRadius: 8 }}
    />
  );
}

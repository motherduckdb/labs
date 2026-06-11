/**
 * The comparison SQL — one source of truth, run verbatim against BOTH the managed
 * Postgres ("before") and MotherDuck via its Postgres wire endpoint ("after").
 * Identical SQL, identical driver; only the connection host changes.
 *
 * Every construct here (date_trunc, SUM/COUNT) is valid in both Postgres and
 * DuckDB/MotherDuck, so nothing is special-cased per engine.
 */

/** Platform-wide: monthly paid revenue + order counts, sliced by shop plan tier.
 *  This is the heavy aggregate — a full scan of ~3.9M order_items joined to orders. */
export const PLATFORM_MONTHLY_REVENUE = /* sql */ `
  SELECT
    s.plan_tier,
    date_trunc('month', o.ordered_at) AS month,
    SUM(oi.line_total)                AS revenue,
    COUNT(DISTINCT o.order_id)        AS orders
  FROM order_items oi
  JOIN orders o ON o.order_id = oi.order_id
  JOIN shops  s ON s.shop_id  = o.shop_id
  WHERE o.status = 'paid'
  GROUP BY 1, 2
  ORDER BY 1, 2
`;

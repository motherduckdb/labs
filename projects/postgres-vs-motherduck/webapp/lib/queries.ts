/**
 * The benchmark/dashboard SQL — one source of truth, run verbatim against BOTH
 * the managed Postgres ("before") and MotherDuck via its Postgres wire endpoint
 * ("after"). Identical SQL, identical driver; only the connection host changes.
 *
 * Every construct here (date_trunc, interval, SUM/COUNT, now()) is valid in both
 * Postgres and DuckDB/MotherDuck, so nothing is special-cased per engine.
 */

/** Platform-wide: monthly paid revenue + order counts, sliced by shop plan tier.
 *  This is the heavy aggregate — a full scan of ~39M order_items joined to orders. */
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

/** Single-shop, customer-facing: revenue by category over the last 12 months.
 *  Scoped by oi.shop_id (the tenant grain). $1 = shop_id. */
export const SHOP_CATEGORY_TREND = /* sql */ `
  SELECT
    c.category_name,
    date_trunc('month', o.ordered_at) AS month,
    SUM(oi.line_total)                AS revenue
  FROM order_items oi
  JOIN orders     o ON o.order_id    = oi.order_id
  JOIN products   p ON p.product_id  = oi.product_id
  JOIN categories c ON c.category_id = p.category_id
  WHERE oi.shop_id = $1
    AND o.status = 'paid'
    AND o.ordered_at >= now() - interval '12 months'
  GROUP BY 1, 2
  ORDER BY 2, 1
`;

/** Quick parity / scale check. */
export const ROW_COUNTS = /* sql */ `
  SELECT
    (SELECT COUNT(*) FROM order_items) AS order_items,
    (SELECT COUNT(*) FROM orders)      AS orders,
    (SELECT COUNT(*) FROM shops)       AS shops
`;

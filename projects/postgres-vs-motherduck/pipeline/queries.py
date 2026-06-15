"""The analytics SQL — run verbatim against Postgres and MotherDuck.

Every construct (date_trunc, interval, SUM/COUNT, now()) is valid in both engines,
so nothing is special-cased.
"""

# Platform-wide: monthly paid revenue + order counts by shop plan tier.
# The heavy aggregate — a full scan of order_items joined to orders.
PLATFORM_MONTHLY_REVENUE = """
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
"""

# Single-shop, customer-facing: revenue by category over the last 12 months.
# {shop} is formatted in (a trusted int), to keep param-binding identical across engines.
SHOP_CATEGORY_TREND = """
  SELECT
    c.category_name,
    date_trunc('month', o.ordered_at) AS month,
    SUM(oi.line_total)                AS revenue
  FROM order_items oi
  JOIN orders     o ON o.order_id    = oi.order_id
  JOIN products   p ON p.product_id  = oi.product_id
  JOIN categories c ON c.category_id = p.category_id
  WHERE oi.shop_id = {shop}
    AND o.status = 'paid'
    AND o.ordered_at >= now() - interval '12 months'
  GROUP BY 1, 2
  ORDER BY 2, 1
"""

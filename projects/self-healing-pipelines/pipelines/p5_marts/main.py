"""P5: SQL marts over P1-P4. Data tests here catch upstream breakage, which the checker groups under
the upstream incident via lineage (each test declares its upstream_assets)."""
from healkit import pipeline
from healkit.execute import execute

NAME = "p5_marts"

MARTS = {
    "daily_weather": """
        SELECT city, start_time::DATE AS day, max(temp_f) AS high_f, min(temp_f) AS low_f, any_value(fetched_at) AS fetched_at
        FROM (SELECT *, CASE temperature_unit WHEN 'F' THEN temperature WHEN 'C' THEN temperature * 9 / 5 + 32 END AS temp_f
              FROM {db}.p2_nws.forecast_periods)
        GROUP BY ALL""",
    "quake_summary": """
        SELECT time::DATE AS day, count(*) AS quakes, max(mag) AS max_mag, avg(depth_km) AS avg_depth_km
        FROM {db}.p4_usgs.earthquakes GROUP BY ALL""",
    "attention": """
        SELECT day, sum(views) AS views, count(DISTINCT article) AS articles FROM {db}.p1_wiki.pageviews GROUP BY ALL""",
    "order_facts": """
        SELECT o.order_id, o.customer_id, o.sku, o.qty, o.status, o.updated_at, p.name AS product, p.category,
               o.qty * p.price AS revenue
        FROM {db}.p3_github.orders o LEFT JOIN {db}.p3_github.products p USING (sku)""",
}


def load(ctx):
    for mart, sql in MARTS.items():
        execute(ctx.con, f"CREATE OR REPLACE TABLE {ctx.table(f'{NAME}.{mart}')} AS {sql.format(db=ctx.db)}")
    ctx.stats["marts"] = len(MARTS)


if __name__ == "__main__":
    pipeline.main(NAME, load)

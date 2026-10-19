"""P1: daily Wikimedia pageviews for the articles listed in p1_wiki.tracked_articles.

API: https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/... (see docs/api.md).
"""
from datetime import date, timedelta
from urllib.parse import quote

from healkit import pipeline, tests
from healkit.execute import execute
from healkit.http import Http

NAME = "p1_wiki"
BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user"
DEFAULT_ARTICLES = ["DuckDB", "Zürich", "Data_warehouse", "SQL", "Apache_Parquet"]
USER_AGENT = "motherduck-labs-self-healing-p1/1.0"


def load(ctx):
    con = ctx.con
    articles_tbl, views_tbl = ctx.table(f"{NAME}.tracked_articles"), ctx.table(f"{NAME}.pageviews")
    execute(con, f"CREATE TABLE IF NOT EXISTS {articles_tbl} (article VARCHAR PRIMARY KEY, added_at TIMESTAMPTZ DEFAULT now())")
    if con.execute(f"SELECT count(*) FROM {articles_tbl}").fetchone()[0] == 0:
        execute(con, f"INSERT INTO {articles_tbl} (article) SELECT unnest(?::VARCHAR[])", [DEFAULT_ARTICLES])
    execute(con, f"""CREATE TABLE IF NOT EXISTS {views_tbl} (
        article VARCHAR, day DATE, views BIGINT, fetched_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (article, day))""")
    articles = [r[0] for r in con.execute(f"SELECT article FROM {articles_tbl} ORDER BY article").fetchall()]

    http = Http(NAME, user_agent=USER_AGENT)
    end = date.today() - timedelta(days=1)
    start = end - timedelta(days=3)
    rows = []
    for article in articles:
        url = f"{BASE}/{quote(article, safe='')}/daily/{start:%Y%m%d}00/{end:%Y%m%d}00"
        for item in http.get_json(url).get("items", []):
            rows.append((item["article"], f"{item['timestamp'][:4]}-{item['timestamp'][4:6]}-{item['timestamp'][6:8]}", item["views"]))
    if rows:
        con.execute("CREATE OR REPLACE TEMP TABLE stg_views (article VARCHAR, day DATE, views BIGINT)")
        con.executemany("INSERT INTO stg_views VALUES (?, ?, ?)", rows)
        execute(con, f"INSERT OR REPLACE INTO {views_tbl} (article, day, views) SELECT article, day, views FROM stg_views")
    tests.record_volume(con, f"{NAME}.pageviews", len(rows))
    ctx.stats.update(articles=len(articles), rows=len(rows), requests=http.requests_made)


if __name__ == "__main__":
    pipeline.main(NAME, load)

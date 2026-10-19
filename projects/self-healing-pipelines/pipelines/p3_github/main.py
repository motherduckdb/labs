"""P3: GitHub REST + CSV fixtures from the fixtures repo.

- issues:        every issue of the fixtures repo (bodies are untrusted text -> injection screen)
- search_issues: closed duckdb/duckdb issues over a trailing window (Search API)
- products:      fixtures/products.csv, full refresh
- orders:        fixtures/orders.csv, incremental on updated_at
Token: `github_read` flight secret (read-only, public repos).
"""
import json
import os
from datetime import datetime, timedelta, timezone

from healkit import chaos, injection, pipeline, tests
from healkit.execute import execute
from healkit.http import Http

NAME = "p3_github"
FIXTURES_REPO = "Alex-Monahan/self-healing-fixtures"
API = "https://api.github.com"
RAW = f"https://raw.githubusercontent.com/{FIXTURES_REPO}/main"


def gh_headers():
    tok = os.environ.get("github_read_GITHUB_TOKEN")
    h = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    return {**h, "Authorization": f"Bearer {tok}"} if tok else h


def load_issues(ctx, http):
    issues, url = [], f"{API}/repos/{FIXTURES_REPO}/issues?state=all&per_page=100"
    while url:
        r = http.get(url, headers=gh_headers())
        issues += [i for i in r.json() if "pull_request" not in i]
        url = r.links.get("next", {}).get("url")
    rows = [(i["number"], i["title"], i.get("body") or "", i["state"], ",".join(sorted(l["name"] for l in i["labels"])),
             i["created_at"], i["updated_at"]) for i in issues]
    con = ctx.con
    con.execute("""CREATE OR REPLACE TEMP TABLE stg_issues (number INTEGER, title VARCHAR, body VARCHAR, state VARCHAR,
        labels VARCHAR, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, injection_p DOUBLE)""")
    screened = injection.screen(con, [f"{r[1]}\n\n{r[2]}" for r in rows])
    con.executemany("INSERT INTO stg_issues VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [(*r, s["p"]) for r, s in zip(rows, screened)])
    tests.quarantine(con, "stg_issues", f"{NAME}.issues", "injection_p >= 0.5", "prompt injection screen (Jev noul >= 0.5)")
    execute(con, f"CREATE OR REPLACE TABLE {ctx.table(NAME + '.issues')} AS SELECT *, now() AS fetched_at FROM stg_issues")
    ctx.stats["issues"] = len(rows)


def load_search(ctx, http):
    days = int(chaos.get(NAME, "search_window_days", "7"))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).date()
    print(f"[{NAME}] search window: closed:>={since} ({days} days)", flush=True)
    q = f"repo:duckdb/duckdb is:issue is:closed closed:>={since}"
    items, page = [], 1
    while True:
        r = http.get(f"{API}/search/issues", params={"q": q, "per_page": 100, "page": page}, headers=gh_headers())
        d = r.json()
        items += d["items"]
        if len(d["items"]) < 100:
            break
        page += 1
    rows = [(i["number"], i["title"], i["closed_at"], i["comments"]) for i in items]
    ctx.con.execute("CREATE OR REPLACE TEMP TABLE stg_search (number INTEGER, title VARCHAR, closed_at TIMESTAMPTZ, comments INTEGER)")
    if rows:
        ctx.con.executemany("INSERT INTO stg_search VALUES (?, ?, ?, ?)", rows)
    execute(ctx.con, f"CREATE OR REPLACE TABLE {ctx.table(NAME + '.search_issues')} AS SELECT DISTINCT * FROM stg_search")
    tests.record_volume(ctx.con, f"{NAME}.search_issues", len(rows))
    ctx.stats.update(search_rows=len(rows), search_pages=page)


def load_products(ctx):
    path = chaos.get(NAME, "products_path", "fixtures/products.csv")
    execute(ctx.con, f"""CREATE OR REPLACE TABLE {ctx.table(NAME + '.products')} AS
        SELECT sku, name, category, price::DECIMAL(10, 2) AS price, now() AS fetched_at
        FROM read_csv('{RAW}/{path}', header = true)""")


def load_orders(ctx):
    path = chaos.get(NAME, "orders_path", "fixtures/orders.csv")
    con, tbl = ctx.con, ctx.table(NAME + ".orders")
    execute(con, f"""CREATE TABLE IF NOT EXISTS {tbl} (order_id INTEGER, customer_id INTEGER, sku VARCHAR, qty INTEGER,
        status VARCHAR, updated_at TIMESTAMPTZ, loaded_at TIMESTAMPTZ)""")
    wm = con.execute(f"SELECT coalesce(max(updated_at), TIMESTAMPTZ '1970-01-01') FROM {tbl}").fetchone()[0]
    con.execute(f"CREATE OR REPLACE TEMP TABLE stg_orders AS SELECT * FROM read_csv('{RAW}/{path}', header = true) WHERE updated_at::TIMESTAMPTZ > ?", [wm])
    n = con.execute("SELECT count(*) FROM stg_orders").fetchone()[0]
    execute(con, f"""INSERT INTO {tbl} SELECT order_id, customer_id, sku, qty, status, updated_at::TIMESTAMPTZ, now()
                     FROM stg_orders""")
    tests.record_volume(con, f"{NAME}.orders", n)
    ctx.stats["orders_new"] = n


def load(ctx):
    http = Http(NAME, user_agent="motherduck-labs-self-healing-p3/1.0 (https://github.com/motherduckdb/labs)")
    load_issues(ctx, http)
    load_search(ctx, http)
    load_products(ctx)
    load_orders(ctx)
    ctx.stats["requests"] = http.requests_made


if __name__ == "__main__":
    pipeline.main(NAME, load, transactional=True)

"""P3b: daily stargazer / fork counts for a few repos. Shares the `github_read` token with P3, so one bad
token surfaces in two jobs - the checker must open one incident for both."""
import os

from healkit import pipeline
from healkit.execute import execute
from healkit.http import Http

NAME = "p3b_github_stars"
REPOS = ["duckdb/duckdb", "motherduckdb/labs", "duckdb/pg_duckdb"]


def load(ctx):
    tok = os.environ.get("github_read_GITHUB_TOKEN")
    headers = {"Accept": "application/vnd.github+json", **({"Authorization": f"Bearer {tok}"} if tok else {})}
    http = Http(NAME, user_agent="motherduck-labs-self-healing-p3b/1.0 (https://github.com/motherduckdb/labs)")
    rows = []
    for repo in REPOS:
        d = http.get_json(f"https://api.github.com/repos/{repo}", headers=headers)
        rows.append((repo, d["stargazers_count"], d["forks_count"], d["open_issues_count"]))
    tbl = ctx.table(NAME + ".repo_stats")
    execute(ctx.con, f"""CREATE TABLE IF NOT EXISTS {tbl} (repo VARCHAR, day DATE, stars INTEGER, forks INTEGER,
        open_issues INTEGER, PRIMARY KEY (repo, day))""")
    ctx.con.execute("CREATE OR REPLACE TEMP TABLE stg AS SELECT * FROM (VALUES " + ", ".join(["(?, ?, ?, ?)"] * len(rows))
                    + ") t(repo, stars, forks, open_issues)", [v for r in rows for v in r])
    execute(ctx.con, f"INSERT OR REPLACE INTO {tbl} SELECT repo, current_date, stars, forks, open_issues FROM stg")
    ctx.stats.update(repos=len(rows))


if __name__ == "__main__":
    pipeline.main(NAME, load)

import pathlib
import shutil
import subprocess

import pytest

from healer.guards import guards
from healkit import sqlguard
from healkit.registry import registry

ROOT = pathlib.Path(__file__).resolve().parent.parent


def test_sqlguard_destructive_outside_profile():
    prof = {("UPSERT", "p1_wiki.pageviews")}
    ok = sqlguard.check("INSERT OR REPLACE INTO heal_lake.p1_wiki.pageviews SELECT 1", prof)[0]
    assert ok.allowed
    for q in ["DELETE FROM heal_lake.p1_wiki.pageviews", "MERGE INTO p3_github.orders USING s ON true WHEN MATCHED THEN UPDATE SET x = 1",
              "CREATE OR REPLACE TABLE p1_wiki.pageviews AS SELECT 1", "ALTER TABLE p1_wiki.pageviews DROP COLUMN views",
              "WITH x AS (SELECT 1) DELETE FROM p1_wiki.pageviews"]:
        assert not sqlguard.check(q, prof)[0].allowed, q


def test_sqlguard_protected_and_split():
    vs = sqlguard.check("SELECT 1; SELECT * FROM heal_chaos.main.world", None, protected=("heal_chaos",))
    assert vs[0].allowed and not vs[1].allowed
    assert len(sqlguard.split_statements("SELECT ';'; SELECT 2 -- ;\n")) == 2


@pytest.fixture()
def repo(tmp_path):
    prefix = registry()["project_path"]
    dst = tmp_path / "repo" / prefix
    shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache", ".venv"))
    r = str(tmp_path / "repo")
    for cmd in (["init", "-q"], ["add", "-A"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]):
        subprocess.run(["git", "-C", r, *cmd], check=True)
    base = subprocess.run(["git", "-C", r, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    return r, base, dst


def test_guard_clean_change(repo):
    r, base, proj = repo
    f = proj / "pipelines/p1_wiki/main.py"
    f.write_text(f.read_text().replace('USER_AGENT = "motherduck-labs-self-healing-p1/1.0"',
                                       'USER_AGENT = "motherduck-labs-self-healing-p1/1.1 (https://github.com/motherduckdb/labs)"'))
    rep = guards.report(r, base, "p1_wiki", "L1")
    assert rep["ok"] and rep["l2_ok"], rep


def test_guard_blocks_lowered_severity_healer_paths_hosts(repo):
    r, base, proj = repo
    t = proj / "pipelines/p1_wiki/tests.yaml"
    t.write_text(t.read_text().replace("columns: [article, day], severity: error", "columns: [article, day], severity: warn"))
    (proj / "healkit/http.py").write_text("# tampered\n")
    m = proj / "pipelines/p1_wiki/main.py"
    m.write_text(m.read_text() + '\nX = "https://evil.example.com/collect"\nimport duckdb\ncon = duckdb.connect("md:")\n')
    rep = guards.report(r, base, "p1_wiki", "L1")
    joined = " | ".join(rep["violations"])
    assert "severity lowered" in joined and "healkit/http.py" in joined and "evil.example.com" in joined and "own database" in joined


def test_guard_l2_block_on_new_destructive_op(repo):
    r, base, proj = repo
    m = proj / "pipelines/p3_github/main.py"
    m.write_text(m.read_text() + '\nSQL = "DELETE FROM p3_github.orders WHERE order_id IN (SELECT 1)"\n')
    o = proj / "pipelines/p3_github/ops.yaml"
    o.write_text(o.read_text() + "  - {kind: DELETE, table: p3_github.orders, source: fixer}\n")
    rep = guards.report(r, base, "p3_github", "L2")
    assert rep["ok"] and not rep["l2_ok"] and any("DELETE" in b for b in rep["l2_blocks"]), rep

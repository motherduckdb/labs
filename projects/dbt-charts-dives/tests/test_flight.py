"""What the Flight sets up before it compiles anything.

Inside a Flight there is no dbt: the run synthesizes the `profiles.yml` dbt Charts reads the
warehouse through. It has to describe the same connection the dbt run used, or a board's
unqualified SQL resolves somewhere else.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
import yaml
from dbt_charts_dive.flight import write_profiles


@pytest.fixture(autouse=True)
def _keep_the_environment(monkeypatch):
    """`write_profiles` points dbt at the project it just wrote; inside a Flight that is the
    whole process, here it is one test."""
    for name in ("DBT_PROFILES_DIR", "DBT_PROJECT_DIR"):
        monkeypatch.setenv(name, os.environ.get(name, ""))


def _project(tmp_path: Path, sources: str = "") -> Path:
    (tmp_path / "dbt_project.yml").write_text("name: analytics\nprofile: warehouse\n", encoding="utf-8")
    if sources:
        (tmp_path / "dbt_charts.yml").write_text(sources, encoding="utf-8")
    return tmp_path


def _outputs(project: Path) -> list[dict]:
    doc = yaml.safe_load((project / "profiles.yml").read_text(encoding="utf-8"))
    return [out for profile in doc.values() for out in profile["outputs"].values()]


def test_the_profile_uses_the_targets_schema(tmp_path):
    """`SELECT * FROM orders` in a board means the schema the dbt run wrote to, not `main`."""
    project = _project(tmp_path)
    write_profiles(project, "warehouse_db", "analytics")
    assert [o["schema"] for o in _outputs(project)] == ["analytics"]
    assert [o["path"] for o in _outputs(project)] == ["md:warehouse_db"]


def test_every_source_target_gets_the_same_schema(tmp_path):
    project = _project(tmp_path, "sources:\n  a:\n    type: dbt_profile\n    profile: p\n    target: md\n  b:\n    type: dbt_profile\n    profile: p\n    target: dev\n")
    write_profiles(project, "db", "reporting")
    assert {o["schema"] for o in _outputs(project)} == {"reporting"}
    assert len(_outputs(project)) == 2


@pytest.mark.parametrize("schema", ["", None])
def test_no_schema_means_main(tmp_path, schema):
    project = _project(tmp_path)
    write_profiles(project, "db", schema)
    assert [o["schema"] for o in _outputs(project)] == ["main"]


# ── the options block is a contract, and a typo in it is not a shrug ──────────
def _options(tmp_path, dive: str):
    (tmp_path / "dbt_charts.yml").write_text(f"dive:\n{dive}\n", encoding="utf-8")
    from dbt_charts_dive.config import load_options

    return load_options(tmp_path)


def test_a_misspelled_publish_mode_is_an_error(tmp_path):
    """`publish: nonee` fell through to publishing everything — the one thing the author
    was trying to prevent."""
    with pytest.raises(ValueError, match="publish"):
        _options(tmp_path, "  publish: nonee")


def test_one_exclude_written_as_a_string_still_excludes(tmp_path):
    """A scalar was iterated one character at a time, so it matched nothing."""
    assert _options(tmp_path, '  exclude: "charts/secret.yml"')["exclude"] == ["charts/secret.yml"]


def test_a_misspelled_key_is_an_error(tmp_path):
    with pytest.raises(ValueError, match="titel_prefix"):
        _options(tmp_path, '  titel_prefix: "dbt: "')


def test_the_block_it_documents_is_accepted(tmp_path):
    opts = _options(tmp_path, "  publish: tagged\n  tag: dive\n  include: []\n  dive_width: 900")
    assert opts["publish"] == "tagged" and opts["dive_width"] == 900

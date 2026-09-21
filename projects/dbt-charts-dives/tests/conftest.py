"""Session setup: locate the dbt project, install the synthetic fixture boards into it, and
expose the ``browser`` marker (headless Chromium runs; ``DCD_E2E_BROWSER=0`` skips them)."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent


def _find_project_dir() -> Path:
    env = os.environ.get("DCD_PROJECT_DIR")
    if env:
        return Path(env).resolve()
    cwd = Path.cwd()
    if (cwd / "dbt_project.yml").exists():
        return cwd
    candidate = HERE.parent / "example_project"
    if (candidate / "dbt_project.yml").exists():
        return candidate
    raise RuntimeError("set DCD_PROJECT_DIR to a dbt project that has dbt Charts boards (see tests/README.md)")


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "browser: renders the Dive in headless Chromium (Playwright); DCD_E2E_BROWSER=0 skips")
    project = _find_project_dir()
    os.environ["DCD_PROJECT_DIR"] = str(project)
    os.environ.setdefault("DBT_PROFILES_DIR", str(project))
    os.chdir(project)


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if os.environ.get("DCD_E2E_BROWSER", "1") == "0":
        skip = pytest.mark.skip(reason="DCD_E2E_BROWSER=0")
        for item in items:
            if "browser" in item.keywords:
                item.add_marker(skip)


@pytest.fixture(scope="session", autouse=True)
def fixture_boards() -> None:
    """Copy tests/fixtures/*.yml into <project>/charts/e2e_fixtures for the session.

    dbt-charts resolves boards inside the project only; the copies (and the width-pinned
    board copies the layout/visual tests write next to them) are removed afterwards.
    """
    project = Path(os.environ["DCD_PROJECT_DIR"])
    dst = project / "charts" / "e2e_fixtures"
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    for src in sorted((HERE / "fixtures").glob("*.yml")):
        shutil.copy(src, dst / src.name)
    if not (HERE / "node_modules").exists():
        subprocess.run(["npm", "install", "--silent"], cwd=HERE, check=True)
    yield
    shutil.rmtree(dst, ignore_errors=True)

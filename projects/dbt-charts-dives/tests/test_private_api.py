"""The private dbt Charts surface this package stands on.

``pyproject.toml`` allows ``dbt-charts>=0.8.0``, so a release newer than the one this was
written against can be installed. The compiler reaches into dbt Charts' own private
functions on purpose — that is how a Dive reuses its Vega-Lite specs, its resolved styles
and its sizing pass instead of re-deriving them — and a renamed one would otherwise show up
as a strange-looking card rather than as an error.

So this test names every private thing the package touches. An unsupported release fails
here, first and by name, and the failure says which version is installed. Behaviour that
moves without being renamed is a different problem, and the rest of the suite is what
catches that: every test here measures the Dive against dbt Charts' own render.
"""

from __future__ import annotations

import importlib
import importlib.metadata
import pathlib
import re

import pytest

# module path -> the private names imported from it
IMPORTED = {
    "dbt_charts.core.compile.format": ["_KPI_SI_COMPACT_THRESHOLD"],
    "dbt_charts.core.compile.template.variables": ["_coerce_member"],
    "dbt_charts.core.execute.adapters.dbt_adapter": ["_read_target_dict"],
    "dbt_charts.core.execute.sql_literals": ["_to_sql_literal"],
    "dbt_charts.core.render.boards": ["_render_text_svg", "_render_title_svg"],
    "dbt_charts.core.render.chart.kpi": ["_rule_output_for_channel"],
    "dbt_charts.core.render.chart.spark_bar": ["_auto_detect_spark_bar_fields", "_validate_spark_bar_value_field"],
    "dbt_charts.core.render.chart.table": ["_svg_font_family", "_table_numeric_cell_font"],
    "dbt_charts.core.render.chart.vega_lite": ["_render_vl_artifact"],
    "dbt_charts.core.text.format_d3": ["_D3_TO_ANALYTIC", "_D3_TO_NARRATIVE"],
}

# the paginator and pagination constants presentation.py copies into the manifest, with the
# type the template expects of each; `T` is dbt_charts.core.render.chart.table
TABLE_CONSTANTS = {
    "_PAGINATION_CONTROL_HEIGHT": (int, float),
    "_PAGINATION_GROW_CAP": int,
    "_PAGINATOR_AUX_SLOT_RATIO": (int, float),
    "_PAGINATOR_BOUNDARY_COUNT": int,
    "_PAGINATOR_ELLIPSIS": str,
    "_PAGINATOR_NEXT_CHEVRON": str,
    "_PAGINATOR_PREV_CHEVRON": str,
    "_PAGINATOR_SIBLING_COUNT": int,
}

# what md_compat.py replaces, and the one name it calls through to
PATCHED = {
    "dbt_charts.core.execute.adapters.dbt_adapter": ["_read_target_dict"],
    "dbt_charts.core.execute.adapters.dbt_adapter_factory": [
        "_patched_duckdb_initialize_db",
        "_original_duckdb_initialize_db",
    ],
}
PATCHED_METHODS = [("dbt_charts.core.execute.adapters.duckdb_adapter", "DuckDBAdapter", m)
                   for m in ("_resolved_path", "_resolve_duckdb_connect_kwargs")]

PRIVATE_MODULES = ["dbt_charts.agent_api._paths"]

WRITTEN_AGAINST = "0.8.0"


def _installed() -> str:
    return importlib.metadata.version("dbt-charts")


def _why(name: str) -> str:
    return f"{name} is gone from dbt-charts {_installed()} (this was written against {WRITTEN_AGAINST})"


@pytest.mark.parametrize("module", sorted(IMPORTED))
def test_the_names_the_compiler_imports_are_still_there(module):
    mod = importlib.import_module(module)
    for name in IMPORTED[module]:
        assert hasattr(mod, name), _why(f"{module}.{name}")


@pytest.mark.parametrize("module", sorted(PATCHED))
def test_the_names_md_compat_patches_are_still_there(module):
    mod = importlib.import_module(module)
    for name in PATCHED[module]:
        assert hasattr(mod, name), _why(f"{module}.{name}")


@pytest.mark.parametrize("module,cls,method", PATCHED_METHODS)
def test_the_adapter_methods_md_compat_narrows_are_still_there(module, cls, method):
    owner = getattr(importlib.import_module(module), cls)
    assert hasattr(owner, method), _why(f"{cls}.{method}")


@pytest.mark.parametrize("module", PRIVATE_MODULES)
def test_the_private_modules_still_exist(module):
    assert importlib.import_module(module), _why(module)


def test_the_table_constants_still_hold_the_types_the_manifest_ships():
    """These travel into the manifest as numbers and strings; a changed type is a changed
    paginator, not an import error."""
    from dbt_charts.core.render.chart import table as T

    for name, kind in TABLE_CONSTANTS.items():
        assert hasattr(T, name), _why(f"table.{name}")
        assert isinstance(getattr(T, name), kind), f"table.{name} is {type(getattr(T, name)).__name__}, expected {kind}"


def test_this_list_is_the_one_the_package_actually_uses():
    """The table above is only worth having if it cannot drift from the source. Every
    private name the package imports must be accounted for here."""
    src = pathlib.Path(__file__).resolve().parents[1] / "src" / "dbt_charts_dive"
    found: set[str] = set()
    for f in sorted(src.glob("*.py")):
        for module, imported in re.findall(r"from (dbt_charts[\w.]*) import ([^\n(]+|\([^)]*\))", f.read_text()):
            for name in imported.strip("() \n").split(","):
                name = name.split(" as ")[0].strip()
                if name.startswith("_") and not name.startswith("__"):
                    found.add(f"{module}.{name}")
    listed = {f"{m}.{n}" for m, ns in IMPORTED.items() for n in ns}
    listed |= {f"{m}.{n}" for m, ns in PATCHED.items() for n in ns}
    listed |= {m.rsplit(".", 1)[0] + "." + m.rsplit(".", 1)[1] for m in PRIVATE_MODULES}
    # a private module imported as a name (`import dbt_adapter as _dbt_adapter`) is the
    # module, not a private attribute of it
    found = {f for f in found if not f.rsplit(".", 1)[1].lstrip("_") in ("dbt_adapter", "factory", "paths", "md_compat")}
    assert found <= listed, f"private names the package uses that this test does not name: {sorted(found - listed)}"


def test_the_installed_version_is_recorded(record_property):
    record_property("dbt_charts_version", _installed())
    assert _installed() >= WRITTEN_AGAINST

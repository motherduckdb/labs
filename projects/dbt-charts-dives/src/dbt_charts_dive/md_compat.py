"""MotherDuck compatibility patches for dbt-charts 0.8.x.

dbt-charts treats every non-absolute DuckDB ``path:`` as a file relative to the
project directory and, for read-only sources, disables DuckDB's external access.
Both break a MotherDuck path (``md:my_db``): the path gets anchored to
``<project>/md:my_db`` and the ``motherduck`` extension can no longer load.

``apply()`` narrows the four functions listed below so an ``md:`` path passes
through untouched and keeps external access (and is opened with the same
connection configuration dbt-duckdb uses, so two connections to one ``md:``
database can coexist in one process). Everything else is left exactly as
dbt-charts does it.

These four are the private names this module depends on; ``builder.py`` borrows
more of them (see its module docstring). All of them are 0.8-only — the version
bound lives in ``pyproject.toml`` and the Flight's requirements.
"""

from __future__ import annotations

from typing import Any

_APPLIED = False
MD_PREFIX = "md:"


def _is_md(path: object) -> bool:
    return isinstance(path, str) and path.startswith(MD_PREFIX)


def _dbt_duckdb_user_agent() -> str | None:
    """The custom_user_agent dbt-duckdb's MotherDuck plugin puts on its connection.

    DuckDB shares one database instance per path only when every connection uses the
    same configuration, so dbt-charts must announce itself exactly like dbt-duckdb
    when both run in the same process (a dbt Python model).
    """
    try:
        from dbt.adapters.duckdb.__version__ import version as dd_version
        from dbt.version import __version__ as dbt_version
    except Exception:  # noqa: BLE001 — dbt-duckdb not installed: nothing to match
        return None
    return f"dbt/{dbt_version} dbt-duckdb/{dd_version}"


def apply() -> None:
    global _APPLIED
    if _APPLIED:
        return
    _APPLIED = True

    from dbt_charts.core.execute.adapters import dbt_adapter as _dbt_adapter
    from dbt_charts.core.execute.adapters.duckdb_adapter import DuckDBAdapter

    # 1. dbt_profile targets: undo the "<project>/md:db" anchoring of the profile path.
    _orig_read_target_dict = _dbt_adapter._read_target_dict

    def _read_target_dict(*args: Any, **kwargs: Any) -> dict[str, Any]:
        target = _orig_read_target_dict(*args, **kwargs)
        path = target.get("path")
        if isinstance(path, str):
            idx = path.find(MD_PREFIX)
            if idx > 0 and path[idx - 1] in "/\\":
                target["path"] = path[idx:]
        return target

    _dbt_adapter._read_target_dict = _read_target_dict

    # 2. Named duckdb sources: an md: path is not relative to the data dir.
    _orig_resolved_path = DuckDBAdapter._resolved_path

    def _resolved_path(self: DuckDBAdapter, source_config: dict[str, Any] | None) -> str:
        if source_config and _is_md(source_config.get("path")):
            return str(source_config["path"])
        if source_config is None and _is_md(getattr(self.source_config, "path", None)):
            return str(self.source_config.path)
        return _orig_resolved_path(self, source_config)

    DuckDBAdapter._resolved_path = _resolved_path  # type: ignore[method-assign]

    # 3. Read-only connections: MotherDuck needs external access to load its extension.
    _orig_connect_kwargs = DuckDBAdapter._resolve_duckdb_connect_kwargs

    def _resolve_duckdb_connect_kwargs(path: str, *args: Any, **kwargs: Any) -> dict[str, Any]:
        out = _orig_connect_kwargs(path, *args, **kwargs)
        if _is_md(path):
            # Inside a dbt run, dbt-duckdb already holds a read-write connection to the
            # same md: database. DuckDB refuses a second connection with a different
            # configuration, so connect exactly like dbt-duckdb does: no read_only flag,
            # no forced config. (dbt-charts only ever issues SELECTs on it anyway.)
            out.pop("read_only", None)
            config = dict(out.get("config") or {})
            config.pop("enable_external_access", None)
            ua = _dbt_duckdb_user_agent()
            if ua:
                config.setdefault("custom_user_agent", ua)
            if config:
                out["config"] = config
            else:
                out.pop("config", None)
        return out

    DuckDBAdapter._resolve_duckdb_connect_kwargs = staticmethod(_resolve_duckdb_connect_kwargs)  # type: ignore[method-assign]

    # 4. dbt-charts patches dbt-duckdb's initialize_db to open profile paths read-only with
    #    external access off (for schema introspection). An md: path must take dbt-duckdb's
    #    own path, which loads the motherduck extension and applies the profile config.
    from dbt_charts.core.execute.adapters import dbt_adapter_factory as _factory

    _orig_patched_init = _factory._patched_duckdb_initialize_db

    def _patched_duckdb_initialize_db(cls: Any, creds: Any, plugins: Any = None) -> Any:
        if _is_md(getattr(creds, "path", None)) and _factory._original_duckdb_initialize_db is not None:
            return _factory._original_duckdb_initialize_db(cls, creds, plugins)
        return _orig_patched_init(cls, creds, plugins)

    _factory._patched_duckdb_initialize_db = _patched_duckdb_initialize_db

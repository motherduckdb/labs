"""Which boards become Dives, and the ``dive:`` options that decide it.

The ``dive:`` block of ``dbt_charts.yml`` is the only configuration this package reads
(plus the ``save_charts_as_dives`` dbt var, which the macro checks before calling anything)::

    dive:
      publish: all            # all | tagged | none
      tag: dive               # opt-in tag when publish: tagged
      exclude_tag: no-dive    # opt-out tag when publish: all
      include: []             # path globs, e.g. ["charts/exec/**"]
      exclude: []
      title_prefix: "dbt: "     # marks these Dives as dbt-managed in the Dive list
      dive_width: 880
      vegalite_version: auto  # the Vega-Lite the specs were compiled for; pin to upgrade
      project: ""             # the namespace a board's Dive is named in; the dbt project's
                              # own name unless two projects share it
      all_or_nothing: true    # a board that cannot be built stops the whole run from
                              # publishing; false publishes the boards that did build
      required_databases: []  # what the Dive attaches; defaults to the databases its SQL
                              # names. Point it at a share to publish Dives others can open:
                              #   ["mydb=md:_share/mydb_share/<uuid>"]
                              # keeping the alias equal to the database name in the SQL.

``plan()`` lists the boards a run should publish, marking the ones to skip and why;
``build()`` compiles one of them into Dive source.
"""

from __future__ import annotations

import re
from fnmatch import fnmatch
from pathlib import Path
from typing import Any

import yaml

import dbt_charts_dive  # noqa: F401 — applies the md: compatibility patches

_REF_RE = re.compile(r"""\{\{\s*ref\(\s*['"]([^'"]+)['"]""")
# dbt-charts' own board-file filter (agent_api/_paths.iter_expanded_board_files): both YAML
# suffixes, no leading-underscore partials, no meta.* cascade fragments.
_BOARD_GLOBS = ("*.yml", "*.yaml")
_NOT_BOARDS = ("meta.yml", "meta.yaml")
_DEFAULTS = {"publish": "all", "tag": "dive", "exclude_tag": "no-dive", "include": [], "exclude": [], "dive_width": 880, "title_prefix": "dbt: ", "vegalite_version": "auto", "project": "", "all_or_nothing": True, "vega_version": None, "vega_embed_version": None,
             "required_databases": []}


_PUBLISH_MODES = ("all", "tagged", "none")
_LIST_OPTIONS = ("include", "exclude", "required_databases")


def load_options(project_dir: Path, overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    """``dive:`` block of dbt_charts.yml, then ``var('dbt_charts_dive')`` overrides, then defaults.

    Checked, not merged blindly: ``publish: nonee`` used to fall through to publishing
    everything, and one path written as a string instead of a list was iterated a character
    at a time and excluded nothing.
    """
    opts = dict(_DEFAULTS)
    cfg = project_dir / "dbt_charts.yml"
    if cfg.exists():
        doc = yaml.safe_load(cfg.read_text(encoding="utf-8")) or {}
        block = doc.get("dive") or {}
        if isinstance(block, dict):
            opts.update(block)
    if overrides:
        opts.update({k: v for k, v in overrides.items() if v is not None})
    return _checked(opts)


def _checked(opts: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(opts) - set(_DEFAULTS))
    if unknown:
        raise ValueError(f"dbt_charts_dive: {', '.join(unknown)} is not a dive: option. Try one of: {', '.join(sorted(_DEFAULTS))}")
    mode = str(opts.get("publish", "all")).lower()
    if mode not in _PUBLISH_MODES:
        raise ValueError(f"dbt_charts_dive: dive.publish must be one of {', '.join(_PUBLISH_MODES)}, not {opts['publish']!r}")
    opts["publish"] = mode
    for name in _LIST_OPTIONS:  # one glob written as a string is one glob, not a pile of letters
        value = opts.get(name)
        if isinstance(value, str):
            opts[name] = [value]
        elif value is not None and not isinstance(value, list):
            raise ValueError(f"dbt_charts_dive: dive.{name} must be a list, not {type(value).__name__}")
    if opts.get("dive_width") is not None:
        opts["dive_width"] = int(opts["dive_width"])
    return opts


def project_name(project_dir: Path) -> str:
    """The dbt project's own name. Two projects can publish into one MotherDuck database,
    and they may well both have a ``charts/sales.yml``; the name is what keeps their Dives
    apart."""
    cfg = project_dir / "dbt_project.yml"
    if cfg.exists():
        doc = yaml.safe_load(cfg.read_text(encoding="utf-8")) or {}
        if isinstance(doc, dict) and doc.get("name"):
            return str(doc["name"])
    return project_dir.resolve().name


def _board_meta(path: Path) -> dict[str, Any]:
    """Title, tags and ``ref()`` names of one board, or ``{"error": …}``.

    Board text is parsed with dbt-charts' own loader (``core.utils.YAML_LOADER``): it is the
    only scanner the library accepts board text from, so a board that compiles there parses
    here, and one that does not is reported as a skip rather than published half-read.
    """
    from dbt_charts.core.utils import YAML_LOADER

    try:
        text = path.read_text(encoding="utf-8")
        doc = yaml.load(text, Loader=YAML_LOADER) or {}  # a CSafeLoader subclass
    except Exception as e:  # noqa: BLE001 — reported per board, never fatal
        return {"error": f"YAML parse error: {e}"}
    if not isinstance(doc, dict):
        return {"error": "board is not a mapping"}
    tags = doc.get("tags") or []
    return {"title": doc.get("title") or path.stem, "tags": [str(t) for t in tags], "refs": sorted(set(_REF_RE.findall(text)))}


def plan(project_dir: Path, options: dict[str, Any], failed_models: list[str]) -> list[dict[str, Any]]:
    charts_dir = project_dir / "charts"
    boards: list[dict[str, Any]] = []
    mode = str(options.get("publish", "all")).lower()
    if mode == "none" or not charts_dir.is_dir():
        return boards
    project = str(options.get("project") or "").strip() or project_name(project_dir)
    include = [str(g) for g in (options.get("include") or [])]
    exclude = [str(g) for g in (options.get("exclude") or [])]
    failed = set(failed_models)
    for path in sorted(p for g in _BOARD_GLOBS for p in charts_dir.rglob(g)):
        rel = path.relative_to(project_dir).as_posix()
        if path.name.startswith("_") or path.name in _NOT_BOARDS:
            continue
        # fnmatch, not PurePath.match: ** has to cross directories (charts/exec/** should
        # reach charts/exec/sub/board.yml), and it means the same thing on every Python.
        if include and not any(fnmatch(rel, g) for g in include):
            continue
        if exclude and any(fnmatch(rel, g) for g in exclude):
            continue
        meta = _board_meta(path)
        # ``legacy_key`` is what the key was before it carried the project name: a Dive
        # published by an earlier version is still found under it, and adopted.
        legacy_key = Path(rel).with_suffix("").as_posix().removeprefix("charts/")
        key = f"{project}:{legacy_key}"
        entry: dict[str, Any] = {"key": key, "legacy_key": legacy_key, "path": rel, "title": meta.get("title", legacy_key)}
        if "error" in meta:
            entry["skip"] = meta["error"]
        elif options["exclude_tag"] in meta["tags"]:
            entry["skip"] = f"tagged {options['exclude_tag']}"
        elif mode == "tagged" and options["tag"] not in meta["tags"]:
            entry["skip"] = f"not tagged {options['tag']}"
        else:
            bad = sorted(set(meta["refs"]) & failed)
            if bad:
                entry["skip"] = "upstream failed: " + ", ".join(bad)
        boards.append(entry)
    return boards


def build(project_dir: Path, board_path: str, options: dict[str, Any]) -> dict[str, Any]:
    from dbt_charts_dive.builder import build_dive_from_boards

    b = build_dive_from_boards(
        project_dir,
        [board_path],
        dive_width=int(options.get("dive_width") or 880),
        options=options,
        required_databases=list(options.get("required_databases") or []) or None,
    )
    # Dive titles carry a prefix so they are recognizable in the MotherDuck Dive list
    # (`dive: {title_prefix: ""}` in dbt_charts.yml turns it off).
    prefix = options.get("title_prefix")
    title = f"{prefix}{b.title}" if prefix else b.title
    return {"title": title, "description": b.description, "content": b.content, "required_resources": b.required_resources, "refs": b.refs}

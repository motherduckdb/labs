"""The Vega runtime the Dive embeds, built at compile time to match dbt Charts.

dbt Charts renders with ``vl-convert``, which bundles specific Vega / Vega-Lite / Vega-Embed
builds and picks the Vega-Lite version from the spec's ``$schema``. The Dive must run the
same Vega-Lite the specs were compiled for, so the bundle is assembled during ``dbt run``:

* Vega-Lite: the ``$schema`` version of the compiled specs (``vegalite_version: auto``),
  or an explicit version from ``dive: {vegalite_version: "6.5.0"}`` — bump that one line to
  move to a newer Vega-Lite.
* Vega and Vega-Embed: the versions vl-convert ships (``vega_version`` /
  ``vega_embed_version`` override them).

The three minified UMD builds are fetched from jsDelivr (npm), concatenated, gzipped and
base64-encoded: exactly the payload ``template.tsx`` inflates with ``DecompressionStream``.

Each payload is cached per version triple in two places. A Flight has a fresh ``/tmp``
every run, so the durable cache is a table in the warehouse
(``dbt_charts_dive_vega``, registered by ``flight.use_warehouse_cache``); local runs and the
test suite also keep a file under ``<project>/target/dbt_charts_dive/``. Only a version
change downloads again.

vl-convert's own ``javascript_bundle`` cannot be used: it exports ``vega`` and ``vegaLite``
as ``null`` from its deno bundle (only ``vegaEmbed`` is usable).
"""

from __future__ import annotations

import base64
import gzip
import re
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

CDN = "https://cdn.jsdelivr.net/npm/{pkg}@{version}/build/{file}"
FILES = (("vega", "vega.min.js"), ("vega-lite", "vega-lite.min.js"), ("vega-embed", "vega-embed.min.js"))
_SCHEMA_RE = re.compile(r"vega-lite/v(\d+(?:\.\d+){0,2})\.json")
_VERSION_RE = re.compile(r'version\s*[:=]\s*"(\d+\.\d+\.\d+[^"]*)"')
_MEMO: dict[tuple[str, str, str], VegaBundle] = {}
_WAREHOUSE: tuple[Any, str] | None = None


def use_warehouse_cache(con: Any, table: str) -> None:
    """Cache bundles in ``table`` on ``con``, keyed by version triple.

    The Flight calls this: its filesystem is new on every run, so a file cache would
    re-download the runtime each time, while the warehouse it is already connected to keeps
    the payload for as long as the versions hold.
    """
    global _WAREHOUSE
    _WAREHOUSE = (con, table)


def _warehouse_get(key: str, versions: tuple[str, str, str]) -> str | None:
    """The cached runtime for ``key``, if what is in the table is that runtime.

    What this table holds is JavaScript that every viewer of every Dive built from it runs,
    and it lives in the project's own schema — so it is checked on the way out, not trusted
    because it is ours: it has to inflate, be the size a runtime is, and carry the three
    versions the key names. That stops the table being a place to leave code in; it is not a
    signature, and whoever can write this schema can write the models the Dives read too.
    """
    if _WAREHOUSE is None:
        return None
    con, table = _WAREHOUSE
    try:
        con.execute(f"CREATE TABLE IF NOT EXISTS {table} (key VARCHAR, b64 VARCHAR, created_at TIMESTAMPTZ)")
        row = con.execute(f"SELECT b64 FROM {table} WHERE key = ? LIMIT 1", [key]).fetchone()
    except Exception as e:  # noqa: BLE001 — a cache miss must never fail the build
        print(f"dbt_charts_dive: vega cache unreadable ({e}); downloading instead", flush=True)
        return None
    if not (row and row[0]):
        return None
    cached = str(row[0])
    wrong = _not_the_runtime(cached, versions)
    if wrong:
        print(f"dbt_charts_dive: ignoring the cached vega runtime for {key} — {wrong}; downloading instead", flush=True)
        return None
    return cached


_MIN_BUNDLE_BYTES = 500_000  # vega alone is well over a megabyte unminified-ish
_MAX_BUNDLE_BYTES = 20_000_000


def _not_the_runtime(b64: str, versions: tuple[str, str, str]) -> str | None:
    """Why this payload is not the Vega runtime those versions name, or None."""
    try:
        js = gzip.decompress(base64.b64decode(b64)).decode("utf-8")
    except Exception as e:  # noqa: BLE001 — anything unreadable is not the runtime
        return f"it does not inflate ({type(e).__name__})"
    if not _MIN_BUNDLE_BYTES < len(js) < _MAX_BUNDLE_BYTES:
        return f"it is {len(js)} bytes"
    for name, version in zip(("vega", "vega-lite", "vega-embed"), versions, strict=True):
        if f'"{version}"' not in js:
            return f"it does not carry {name} {version}"
    return None


def _warehouse_put(key: str, b64: str) -> None:
    if _WAREHOUSE is None:
        return
    con, table = _WAREHOUSE
    try:
        con.execute(f"DELETE FROM {table} WHERE key = ?", [key])
        con.execute(f"INSERT INTO {table} SELECT ?, ?, now()", [key, b64])
    except Exception as e:  # noqa: BLE001
        print(f"dbt_charts_dive: could not cache the vega bundle ({e})", flush=True)


@dataclass(frozen=True)
class VegaBundle:
    vega: str
    vega_lite: str
    vega_embed: str
    b64: str
    source: str  # "cache" | "cdn"
    vl_convert: str

    def manifest(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("b64")
        return d


def vl_convert_versions() -> dict[str, str]:
    """Vega / Vega-Embed / latest Vega-Lite as bundled by the installed vl-convert."""
    import importlib.metadata as m

    import vl_convert as vlc

    return {
        "vega": vlc.get_vega_version(),
        "vega_embed": vlc.get_vega_embed_version(),
        "vega_lite": vlc.get_vegalite_versions()[-1],
        "vl_convert": m.version("vl-convert-python"),
    }


def schema_version(specs: list[dict[str, Any]]) -> str | None:
    """The Vega-Lite version dbt Charts compiled the specs for (from ``$schema``)."""
    for spec in specs:
        m = _SCHEMA_RE.search(str(spec.get("$schema", "")))
        if m:
            return m.group(1)
    return None


def resolve_versions(options: dict[str, Any], specs: list[dict[str, Any]]) -> tuple[str, str, str, str]:
    vlc = vl_convert_versions()
    want = str(options.get("vegalite_version") or "auto").strip().lstrip("v")
    vl = want if want != "auto" else (schema_version(specs) or vlc["vega_lite"])
    vega = str(options.get("vega_version") or vlc["vega"]).lstrip("v")
    embed = str(options.get("vega_embed_version") or vlc["vega_embed"]).lstrip("v")
    return vega, vl, embed, vlc["vl_convert"]


def _fetch(url: str) -> str:
    with urllib.request.urlopen(url, timeout=60) as r:  # noqa: S310 — pinned jsDelivr URL
        return r.read().decode("utf-8")


def _detected_version(js: str) -> str | None:
    m = _VERSION_RE.search(js[:20000]) or _VERSION_RE.search(js)
    return m.group(1) if m else None


def get_bundle(project_dir: Path, options: dict[str, Any], specs: list[dict[str, Any]]) -> VegaBundle:
    vega, vl, embed, vlcv = resolve_versions(options, specs)
    if vl.count(".") < 2:
        # vl-convert reports its Vega-Lite builds as two components ("6.4"), which jsDelivr
        # resolves to whatever the latest 6.4.x is. Pin it to the exact release now, so the
        # cache key names one runtime and two machines get the same bytes.
        vl = _exact_version("vega-lite", vl) or vl
    key = f"vega-{vega}_vega-lite-{vl}_vega-embed-{embed}"
    memo_key = (vega, vl, embed)
    if memo_key in _MEMO:
        return _MEMO[memo_key]

    cached = _warehouse_get(key, (vega, vl, embed))
    source = "warehouse"
    if cached is None:
        cache_dir = Path(options.get("bundle_cache_dir") or (project_dir / "target" / "dbt_charts_dive"))
        cache_file = cache_dir / f"{key}.b64"
        if cache_file.exists() and not _not_the_runtime(cache_file.read_text(encoding="utf-8").strip(), (vega, vl, embed)):
            cached, source = cache_file.read_text(encoding="utf-8").strip(), "cache"
        else:
            print(f"dbt_charts_dive: fetching the vega runtime ({key})", flush=True)
            cached, source = _download(vega, vl, embed, cache_dir), "cdn"
            cache_dir.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(cached, encoding="utf-8")
        _warehouse_put(key, cached)

    bundle = VegaBundle(vega, vl, embed, cached, source, vlcv)
    _MEMO[memo_key] = bundle
    return bundle


def _exact_version(pkg: str, partial: str) -> str | None:
    """The full version jsDelivr serves for a partial one, read out of the build itself.

    Minified builds do not all carry a ``version:"x.y.z"`` marker, so this looks for the most
    frequent quoted literal that extends the requested prefix ("6.4" -> "6.4.3").
    """
    from collections import Counter

    try:
        js = _fetch(CDN.format(pkg=pkg, version=partial, file=f"{pkg}.min.js"))
    except Exception:  # noqa: BLE001 — falls back to the partial version
        return None
    hits = re.findall(r'"(' + re.escape(partial) + r'\.\d+(?:[-.][0-9A-Za-z.]+)?)"', js)
    return Counter(hits).most_common(1)[0][0] if hits else None


def _download(vega: str, vl: str, embed: str, cache_dir: Path) -> str:
    parts: list[str] = []
    for pkg, file in FILES:
        version = {"vega": vega, "vega-lite": vl, "vega-embed": embed}[pkg]
        url = CDN.format(pkg=pkg, version=version, file=file)
        try:
            js = _fetch(url)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(
                f"dbt_charts_dive: could not download {url} ({e}). The Dive needs the Vega runtime; "
                f"check the version in dbt_charts.yml (dive.vegalite_version) or network access. "
                f"A previously built bundle would be reused from {cache_dir}."
            ) from e
        if len(js) < 20_000 or "Failed to resolve" in js[:400]:
            raise RuntimeError(f"dbt_charts_dive: {url} did not return a JavaScript build (is {pkg}@{version} a real version?)")
        found = _detected_version(js)
        if found and not found.startswith(version):
            raise RuntimeError(f"dbt_charts_dive: {url} reports version {found}, expected {version}")
        parts.append(js.rstrip() + "\n")
    return base64.b64encode(gzip.compress("".join(parts).encode("utf-8"), 9)).decode("ascii")

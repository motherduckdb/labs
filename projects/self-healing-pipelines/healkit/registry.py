"""pipelines.yaml + categories.yaml accessors."""
import functools
import pathlib

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
LEVELS = ["L3", "L2", "L1"]   # increasing autonomy


@functools.lru_cache(maxsize=1)
def registry() -> dict:
    return yaml.safe_load((ROOT / "pipelines.yaml").read_text())


@functools.lru_cache(maxsize=1)
def categories() -> dict:
    return yaml.safe_load((ROOT / "healer/memory/categories.yaml").read_text())


def pipeline(name: str) -> dict:
    return registry()["pipelines"][name]


def pipeline_by_flight(flight_id: str):
    for name, p in registry()["pipelines"].items():
        if p.get("flight_id") and str(p["flight_id"]) == str(flight_id):
            return name, p
    return None, None


def category_of(cls: str) -> str:
    return categories()["classes"].get(cls, categories()["classes"]["unclassified"])["category"]


def class_info(cls: str) -> dict:
    return categories()["classes"].get(cls, categories()["classes"]["unclassified"])


def effective_level(pipeline_name: str | None, cls: str) -> str | None:
    """min(pipeline ceiling, class ceiling). None = class never gets a fixer. healer faults are L3."""
    ceiling = class_info(cls)["ceiling"]
    if ceiling == "none":
        return None
    p_level = pipeline(pipeline_name)["autonomy"] if pipeline_name in registry()["pipelines"] else "L3"
    return min(p_level, ceiling, key=LEVELS.index)


def upstream_of(name: str) -> list[str]:
    p = registry()["pipelines"].get(name) or {}
    return p.get("upstream", [])


def resources_of(name: str) -> list[str]:
    p = registry()["pipelines"].get(name) or {}
    return p.get("resources", [])

"""CI sanity checks for pipelines.yaml, categories.yaml and the Jev task config."""
import pathlib
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
reg = yaml.safe_load((ROOT / "pipelines.yaml").read_text())
cats = yaml.safe_load((ROOT / "healer/memory/categories.yaml").read_text())
jev = yaml.safe_load((ROOT / "healer/jev/tasks.yaml").read_text())
errors = []

real = [c for c in cats["categories"] if c != "other"]
if not 5 <= len(real) <= 10:
    errors.append(f"categories: {len(real)} (+ other); keep 5-10")
if "other" not in cats["categories"]:
    errors.append("categories: `other` is required")
for name, c in cats["classes"].items():
    if c["category"] not in cats["categories"]:
        errors.append(f"class {name}: unknown category {c['category']}")
    if c["ceiling"] not in ("L1", "L2", "L3", "none"):
        errors.append(f"class {name}: bad ceiling {c['ceiling']}")
    if c["kind"] not in ("T", "P"):
        errors.append(f"class {name}: bad kind {c['kind']}")
    if not c.get("description"):
        errors.append(f"class {name}: description required (Jev labels use it)")
used = {c["category"] for c in cats["classes"].values()}
for c in real:
    if c not in used:
        errors.append(f"category {c}: no class maps to it")

assets = {}
for name, p in reg["pipelines"].items():
    d = ROOT / pathlib.Path(p["entry"]).parent
    for f in ("tests.yaml", "ops.yaml", "requirements.txt", "docs/api.md"):
        if not (d / f).exists():
            errors.append(f"pipeline {name}: missing {f}")
    if not (ROOT / p["entry"]).exists():
        errors.append(f"pipeline {name}: missing entry {p['entry']}")
    if p["autonomy"] not in ("L1", "L2", "L3"):
        errors.append(f"pipeline {name}: bad autonomy {p['autonomy']}")
    for u in p.get("upstream", []):
        if u not in reg["pipelines"]:
            errors.append(f"pipeline {name}: unknown upstream {u}")
    for a in p.get("assets", []):
        assets[a] = name
for name, p in reg["pipelines"].items():
    tests = yaml.safe_load((ROOT / pathlib.Path(p["entry"]).parent / "tests.yaml").read_text()).get("tests", [])
    for t in tests:
        if t.get("severity", "error") not in ("error", "warn"):
            errors.append(f"{name} test {t['name']}: bad severity")
        for ua in t.get("upstream_assets", []):
            if ua not in assets:
                errors.append(f"{name} test {t['name']}: unknown upstream asset {ua}")
for task, t in jev["tasks"].items():
    if t["mode"] not in ("choice", "noul", "score"):
        errors.append(f"jev task {task}: bad mode")

print("\n".join(errors) or "registry OK")
sys.exit(1 if errors else 0)

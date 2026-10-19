"""Deterministic guard report for a fix (§10). No LLM. Used by the fixer before approval and by CI.

    violations  -> hard blocks at every level (the fixer must revise)
    l2_blocks   -> fine at L1; at L2 the fix is downgraded to an L3 proposal

Patch rules: only the affected pipeline's paths; nothing under healer/, healkit/, bootstrap/, sql/,
scenarios/, .github/ or pipelines.yaml (those are healer code: L3 proposals only, for healer incidents);
no deleted tests and no lowered test severity; no new network hosts; no secrets in the diff; no
direct database access or chaos references in pipeline code.
Op profile: destructive SQL in added lines, or destructive ops added to ops.yaml, outside the
pipeline's learned profile -> l2_block.
"""
import re
import subprocess
from urllib.parse import urlsplit

import yaml

from healkit import sqlguard
from healkit.redact import redact
from healkit.registry import registry

HEALER_PATHS = ("healer/", "healkit/", "bootstrap/", "sql/", "scenarios/", ".github/", "pipelines.yaml", "scripts/", "dive/")
ALWAYS_OK_HOSTS = {"github.com", "docs.github.com", "w.wiki", "meta.wikimedia.org", "phabricator.wikimedia.org", "opencode.ai"}
SEVERITY_RANK = {"warn": 0, "error": 1}
_SQL_IN_STRING = re.compile(r"""(?is)["'](\s*(?:UPDATE|DELETE|TRUNCATE|DROP|ALTER|MERGE|INSERT|CREATE\s+OR\s+REPLACE)\b[^"']*)""")


def git(repo, *args) -> str:
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, check=True).stdout


def changed_files(repo: str, base: str, prefix: str) -> list[tuple[str, str]]:
    """[(status, path relative to the project)] for the working tree vs base."""
    out = git(repo, "diff", "--name-status", base, "--", prefix)
    files = []
    for line in out.splitlines():
        parts = line.split("\t")
        files.append((parts[0][0], parts[-1][len(prefix):].lstrip("/")))
    # untracked new files
    for path in git(repo, "ls-files", "--others", "--exclude-standard", "--", prefix).splitlines():
        files.append(("A", path[len(prefix):].lstrip("/")))
    return files


def added_lines(repo: str, base: str, path: str) -> list[str]:
    try:
        diff = git(repo, "diff", base, "--", path)
    except subprocess.CalledProcessError:
        diff = ""
    if not diff:
        try:
            return open(f"{repo}/{path}").read().splitlines()
        except OSError:
            return []
    return [l[1:] for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++")]


def file_at(repo: str, rev: str, path: str) -> str | None:
    try:
        return git(repo, "show", f"{rev}:{path}")
    except subprocess.CalledProcessError:
        return None


def allowed_hosts(pipeline: str) -> set[str]:
    p = registry()["pipelines"].get(pipeline, {})
    return {r.split(":", 1)[1] for r in p.get("resources", []) if r.startswith("host:")} | ALWAYS_OK_HOSTS


def report(repo: str, base: str, pipeline: str, level: str, healer_incident: bool = False) -> dict:
    prefix = registry()["project_path"]
    files = changed_files(repo, base, prefix)
    violations, l2_blocks, notes = [], [], []
    own = f"pipelines/{pipeline}/"
    for status, path in files:
        if any(path.startswith(h) or path == h for h in HEALER_PATHS):
            if healer_incident and level == "L3":
                notes.append(f"healer path {path} changed (healer incident, L3 proposal)")
            else:
                violations.append(f"path {path}: healer code may only change in an L3 proposal for a healer incident")
        elif not path.startswith(own):
            violations.append(f"path {path}: outside the affected pipeline ({own})")
        if status == "D" and path.endswith("tests.yaml"):
            violations.append(f"{path}: tests file deleted")

    # tests: no deleted tests, no lowered severity
    tpath = f"{prefix}/{own}tests.yaml"
    old, new = file_at(repo, base, tpath), (open(f"{repo}/{tpath}").read() if _exists(repo, tpath) else None)
    if old:
        old_t = {t["name"]: t for t in (yaml.safe_load(old) or {}).get("tests", [])}
        new_t = {t["name"]: t for t in (yaml.safe_load(new or "") or {}).get("tests", [])}
        for name, t in old_t.items():
            if name not in new_t:
                violations.append(f"test {name} deleted")
            elif SEVERITY_RANK.get(new_t[name].get("severity", "error"), 1) < SEVERITY_RANK.get(t.get("severity", "error"), 1):
                violations.append(f"test {name}: severity lowered {t.get('severity', 'error')} -> {new_t[name].get('severity')}")
            elif new_t[name].get("type") != t.get("type") or new_t[name].get("asset") != t.get("asset"):
                violations.append(f"test {name}: type or asset changed")

    hosts = allowed_hosts(pipeline)
    from healkit.execute import profile as op_profile
    prof = op_profile(pipeline)
    for status, path in files:
        if status == "D":
            continue
        full = f"{prefix}/{path}"
        lines = added_lines(repo, base, full)
        text = "\n".join(lines)
        if redact(text) != text:
            violations.append(f"{path}: looks like a secret in the added lines")
        for url in re.findall(r"https?://[^\s\"'<>)]+", text):
            host = urlsplit(url).hostname or ""
            if host and host not in hosts and not any(host.endswith("." + h) for h in hosts):
                violations.append(f"{path}: new network host {host}")
        if path.endswith(".py"):
            if "heal_chaos" in text or "HEAL_CHAOS" in text:
                violations.append(f"{path}: references the chaos world config")
            if re.search(r"\bduckdb\.connect\b|\bmd:\b|motherduck_token|MOTHERDUCK_TOKEN", text):
                violations.append(f"{path}: opens its own database connection (use the pipeline context)")
            if re.search(r"\b(os\.system|subprocess|eval\(|exec\()", text):
                violations.append(f"{path}: shell / dynamic code execution")
            for m in _SQL_IN_STRING.finditer(text):
                for v in sqlguard.check(m.group(1).replace("{", "").replace("}", ""), prof):
                    if not v.allowed:
                        l2_blocks.append(f"{path}: {v}")
        if path.endswith("ops.yaml"):
            old_ops = {(o["kind"], o["table"]) for o in (yaml.safe_load(file_at(repo, base, full) or "") or {}).get("ops", [])}
            new_ops = {(o["kind"], o["table"]) for o in (yaml.safe_load(open(f"{repo}/{full}").read()) or {}).get("ops", [])}
            for kind, table in sorted(new_ops - old_ops):
                if kind in sqlguard.DESTRUCTIVE:
                    l2_blocks.append(f"ops.yaml adds destructive op {kind} on {table}")
            for kind, table in sorted(old_ops - new_ops):
                notes.append(f"ops.yaml removes {kind} on {table}")
    return {"files": [f"{s} {p}" for s, p in files], "violations": violations, "l2_blocks": sorted(set(l2_blocks)),
            "notes": notes, "ok": not violations, "l2_ok": not violations and not l2_blocks}


def _exists(repo, path):
    import os
    return os.path.exists(f"{repo}/{path}")


def render(r: dict) -> str:
    lines = ["| check | result |", "|---|---|",
             f"| files | {', '.join(r['files']) or '-'} |",
             f"| hard violations | {'none' if not r['violations'] else '<br>'.join(r['violations'])} |",
             f"| L2 blocks | {'none' if not r['l2_blocks'] else '<br>'.join(r['l2_blocks'])} |"]
    if r["notes"]:
        lines.append(f"| notes | {'<br>'.join(r['notes'])} |")
    return "\n".join(lines)

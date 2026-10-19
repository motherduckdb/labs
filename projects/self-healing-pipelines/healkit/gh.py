"""Small GitHub REST client for the healer: issues, labels, PRs, checks, merge, compare.

Token: the `github` flight secret (fine-grained PAT scoped to the labs + fixtures repos).
Everything written to GitHub is redacted first - labs is a public repo.
"""
import os
import time

import requests

from .redact import redact

API = "https://api.github.com"


class GitHub:
    def __init__(self, repo: str, token: str | None = None):
        self.repo = repo
        self.token = token or os.environ.get("github_GITHUB_TOKEN") or os.environ.get("HEAL_GH_TOKEN")
        self.s = requests.Session()
        self.s.headers.update({"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                               "User-Agent": "motherduck-labs-self-healing/1.0"})
        if self.token:
            self.s.headers["Authorization"] = f"Bearer {self.token}"

    @property
    def enabled(self) -> bool:
        return bool(self.token) and os.environ.get("HEAL_GITHUB", "on") != "off"

    def _req(self, method, path, **kw):
        url = path if path.startswith("http") else f"{API}/repos/{self.repo}{path}"
        for attempt in range(3):
            r = self.s.request(method, url, timeout=30, **kw)
            if r.status_code in (502, 503, 504) or (r.status_code == 403 and "rate limit" in r.text.lower()):
                time.sleep(3 * (attempt + 1))
                continue
            break
        if r.status_code >= 400:
            raise RuntimeError(f"GitHub {method} {path}: {r.status_code} {r.text[:300]}")
        return r.json() if r.text else {}

    # issues ---------------------------------------------------------------------------------------
    def ensure_labels(self, names: list[str]):
        colors = {"heal": "5319e7", "level": "fbca04", "category": "0e8a16", "incident": "c5def5", "healer": "d93f0b"}
        for n in names:
            try:
                self._req("POST", "/labels", json={"name": n, "color": colors.get(n.split(":")[0], "ededed")})
            except RuntimeError as e:
                if "already_exists" not in str(e):
                    raise

    def create_issue(self, title, body, labels):
        self.ensure_labels(labels)
        return self._req("POST", "/issues", json={"title": redact(title)[:250], "body": redact(body)[:60000], "labels": labels})

    def comment(self, number, body):
        return self._req("POST", f"/issues/{number}/comments", json={"body": redact(body)[:60000]})

    def set_labels(self, number, add=(), remove=()):
        if add:
            self.ensure_labels(list(add))
            self._req("POST", f"/issues/{number}/labels", json={"labels": list(add)})
        for l in remove:
            try:
                self._req("DELETE", f"/issues/{number}/labels/{requests.utils.quote(l, safe='')}")
            except RuntimeError:
                pass

    def close_issue(self, number, reason="completed"):
        return self._req("PATCH", f"/issues/{number}", json={"state": "closed", "state_reason": reason})

    def reopen_issue(self, number):
        return self._req("PATCH", f"/issues/{number}", json={"state": "open"})

    def open_items_with_label(self, label):
        return self._req("GET", f"/issues?state=open&labels={requests.utils.quote(label, safe='')}&per_page=50")

    # pulls ----------------------------------------------------------------------------------------
    def create_pr(self, head, base, title, body, labels, draft=False):
        pr = self._req("POST", "/pulls", json={"head": head, "base": base, "title": redact(title)[:250],
                                                "body": redact(body)[:60000], "draft": draft})
        self.set_labels(pr["number"], add=labels)
        return pr

    def pr(self, number):
        return self._req("GET", f"/pulls/{number}")

    def checks(self, sha) -> tuple[str, list]:
        """('pending'|'success'|'failure'|'none', runs) for the check runs on a commit."""
        runs = self._req("GET", f"/commits/{sha}/check-runs?per_page=50").get("check_runs", [])
        if not runs:
            return "none", runs
        if any(r["status"] != "completed" for r in runs):
            return "pending", runs
        ok = all(r["conclusion"] in ("success", "neutral", "skipped") for r in runs)
        return ("success" if ok else "failure"), runs

    def wait_checks(self, sha, timeout_s=900, poll_s=15) -> str:
        deadline, state = time.time() + timeout_s, "none"
        seen_any = False
        while time.time() < deadline:
            state, runs = self.checks(sha)
            seen_any |= bool(runs)
            if state in ("success", "failure"):
                return state
            time.sleep(poll_s)
        return state if seen_any else "none"

    def merge(self, number, sha, method="squash", title=None):
        return self._req("PUT", f"/pulls/{number}/merge", json={"sha": sha, "merge_method": method,
                                                                  **({"commit_title": title} if title else {})})

    def compare(self, base, head):
        return self._req("GET", f"/compare/{base}...{head}")

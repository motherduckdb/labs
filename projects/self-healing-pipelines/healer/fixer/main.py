"""Fixer Flight: one run per incident (§10). opencode + Claude edits; GPT approves separately.

MODE=fix               lease -> clone -> sandbox -> deterministic repro -> opencode -> guards -> approver
                       (revise up to APPROVER_ROUNDS) -> PR -> CI -> merge (L1/L2) or proposal (L3) -> Guide draft
MODE=revert            regression: revert the previous fix through a PR, then continue as MODE=fix
MODE=category_proposal L3 PR proposing a new category in categories.yaml from recurring `other` incidents
Config (flight env, overridable per run): INCIDENT_ID AUTONOMY MODE ATTEMPT BUDGET_USD APPROVER_ROUNDS MODEL
APPROVER_MODEL RUNTIME_CAP_S OPENCODE_STEPS HEAL_LEASE_S. Secrets: openrouter, github, github_read.
"""
import json
import os
import pathlib
import platform
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
import time
import traceback
import urllib.request

from healkit import db, flights, llm
from healkit.gh import GitHub
from healkit.redact import redact
from healkit.registry import LEVELS, registry

from healer.checker import lifecycle
from healer.fixer.broker import Broker
from healer.guards import guards
from healer.memory import guides

S = db.STATE_DB
E = os.environ
HERE = pathlib.Path(__file__).resolve().parent
PROJ = registry()["project_path"]
WORK = pathlib.Path("/tmp/heal_fix")
GH_MODE = E.get("HEAL_GITHUB_MODE", "direct")   # direct: fixes are heal.code_patches rows (no GitHub write access yet)


def sh(cmd, cwd=None, check=True, env=None, timeout=600):
    r = subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str), capture_output=True, text=True, env=env, timeout=timeout)
    if check and r.returncode:
        raise RuntimeError(f"command failed ({r.returncode}): {redact(cmd if isinstance(cmd, str) else ' '.join(cmd))}\n{redact(r.stderr)[-1500:]}")
    return r.stdout


class Stop(Exception):
    """End the run with an outcome (escalated, over_budget, ...)."""

    def __init__(self, outcome, why):
        super().__init__(why)
        self.outcome, self.why = outcome, why


class Fixer:
    def __init__(self):
        self.incident_id = int(E["INCIDENT_ID"])
        self.mode = E.get("MODE", "fix")
        self.attempt = int(E.get("ATTEMPT", "1"))
        self.budget = float(E.get("BUDGET_USD", "10"))
        self.rounds = int(E.get("APPROVER_ROUNDS", "2"))
        self.model = E.get("MODEL", "~anthropic/claude-opus-latest")
        self.approver_model = E.get("APPROVER_MODEL", "~openai/gpt-sol-latest")
        self.runtime_cap = int(E.get("RUNTIME_CAP_S", "2700"))
        self.max_steps = int(E.get("OPENCODE_STEPS", "80"))
        self.lease_s = int(E.get("HEAL_LEASE_S", "900"))
        self.t0 = time.time()
        self.con = db.connect()
        ctx = db.run_context()
        self.flight_run = ctx["run_number"]
        self.run_id = f"inc{self.incident_id}-a{self.attempt}-r{self.flight_run or 'local'}"
        self.inc = lifecycle.incident(self.con, self.incident_id)
        if not self.inc:
            raise Stop("noop", f"incident {self.incident_id} not found")
        self.pipeline = self.inc["pipeline"]
        self.healer_incident = self.pipeline == "healer"
        self.downstream = [p for p in (self.inc.get("pipelines") or []) if p != self.pipeline and p in registry()["pipelines"]]
        requested = E.get("AUTONOMY", self.inc.get("level") or "L3")
        self.level = min(requested, self.inc.get("level") or "L3", key=LEVELS.index)
        if self.healer_incident or self.mode == "category_proposal":
            self.level = "L3"
        self.sandbox = f"heal_sbx_{self.incident_id}_a{self.attempt}"
        self.repo = WORK / "repo"
        self.proj = self.repo / PROJ
        self.base_branch = E.get("HEAL_REF", registry()["base_branch"])
        self.cost = 0.0
        self.repro = None
        self.gh = GitHub(registry()["repo"])
        self._last_touch = 0
        self.approver_log = []
        self.shortlist, self.playbook_id = [], None

    # ------------------------------------------------------------------------------ lease & cost
    def claim(self):
        me = f"fixer-run:{self.flight_run}"
        n = self.con.execute(f"""UPDATE {S}.main.incidents SET lease_owner = ?, lease_expires = now() + to_seconds(?)
                                 WHERE incident_id = ? AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires < now())
                                 RETURNING incident_id""", [me, self.lease_s, self.incident_id, me]).fetchall()
        if not n:
            raise Stop("noop", "lease held by another fixer run")
        self.con.execute(f"""INSERT OR REPLACE INTO {S}.main.fixer_runs (fixer_run_id, incident_id, attempt, flight_run_number, started_at,
                             status, level, model, approver_model, cost_usd, approver_rounds) VALUES (?, ?, ?, ?, now(), 'running', ?, ?, ?, 0, 0)""",
                         [self.run_id, self.incident_id, self.attempt, self.flight_run, self.level, self.model, self.approver_model])

    def touch(self, force=False):
        if not force and time.time() - self._last_touch < 30:
            return
        self._last_touch = time.time()
        c = db.shared()
        c.execute(f"UPDATE {S}.main.incidents SET lease_expires = now() + to_seconds(?) WHERE incident_id = ? AND lease_owner = ?",
                  [self.lease_s, self.incident_id, f"fixer-run:{self.flight_run}"])
        c.execute(f"UPDATE {S}.main.fixer_runs SET cost_usd = ? WHERE fixer_run_id = ?", [round(self.cost, 4), self.run_id])
        ctl = dict(c.execute(f"SELECT key, value FROM {S}.main.control").fetchall())
        if ctl.get("kill_switch") == "on":
            raise Stop("killed", "kill switch is on")

    def spend(self, usd, what):
        self.cost += usd or 0
        if self.cost > self.budget:
            raise Stop("over_budget", f"spent ${self.cost:.2f} > budget ${self.budget:.2f} ({what})")

    def check_time(self):
        if time.time() - self.t0 > self.runtime_cap:
            raise Stop("runtime_cap", f"runtime cap {self.runtime_cap}s reached")

    # ---------------------------------------------------------------------------- repo & sandbox
    def setup_repo(self):
        if WORK.exists():
            shutil.rmtree(WORK)
        WORK.mkdir(parents=True)
        tok = E.get("github_GITHUB_TOKEN", "")
        auth = f"x-access-token:{tok}@" if tok else ""
        sh(f"git clone -q --depth 200 --branch {self.base_branch} https://{auth}github.com/{registry()['repo']} {self.repo}", timeout=300)
        sh(["git", "-C", str(self.repo), "config", "user.name", "self-healing fixer"])
        sh(["git", "-C", str(self.repo), "config", "user.email", "self-healing-fixer@users.noreply.github.com"])
        self.branch = f"heal/{self.incident_id}-a{self.attempt}" + ("-revert" if self.mode == "revert" else "")
        sh(["git", "-C", str(self.repo), "checkout", "-q", "-b", self.branch])
        self.apply_direct_patches()
        self.base_sha = sh(["git", "-C", str(self.repo), "rev-parse", "HEAD"]).strip()
        self.base_tree = sh(["git", "-C", str(self.repo), "rev-parse", "HEAD^{tree}"]).strip()

    def apply_direct_patches(self):
        """Direct mode: the code the pipelines actually run is git + active patches; start from exactly that."""
        rows = self.con.execute(f"SELECT patch_id, patch FROM {S}.main.code_patches WHERE ref = ? AND status = 'active' ORDER BY patch_id",
                                [self.base_branch]).fetchall()
        for pid, patch in rows:
            f = WORK / f"patch_{pid}.diff"
            f.write_text(patch)
            r = subprocess.run(["git", "-C", str(self.repo), "apply", "--whitespace=nowarn", str(f)], capture_output=True, text=True)
            if r.returncode:
                print(f"patch {pid} does not apply: {r.stderr[-300:]}", flush=True)
                continue
            sh(["git", "-C", str(self.repo), "add", "-A"])
            sh(["git", "-C", str(self.repo), "commit", "-q", "-m", f"direct patch {pid}"])
        self.applied_patches = [r[0] for r in rows]

    def tree_hash(self):
        sh(["git", "-C", str(self.repo), "add", "-A", "--", PROJ])
        return sh(["git", "-C", str(self.repo), "write-tree"]).strip()

    def tree_changed(self):
        return self.tree_hash() != self.base_tree

    def reset_sandbox(self):
        self.con.execute(f"DROP DATABASE IF EXISTS {self.sandbox}")
        self.con.execute(f"CREATE DATABASE {self.sandbox} FROM {registry()['data_db']}")

    def drop_sandbox(self):
        try:
            self.con.execute(f"DROP DATABASE IF EXISTS {self.sandbox}")
        except Exception as e:
            print(f"could not drop sandbox: {e}", flush=True)

    def chaos_snapshot(self, p):
        rows = self.con.execute(f"""SELECT knob, value FROM {registry()['chaos_db']}.main.world
                                    WHERE pipeline IN (?, '*') AND coalesce(runs_remaining, 1) > 0""", [p]).fetchall()
        return json.dumps(dict(rows))

    def run_pipeline(self, p):
        self.check_time()
        entry = registry()["pipelines"][p]["entry"]
        req = self.proj / os.path.dirname(entry) / "requirements.txt"
        if req.exists():
            subprocess.run(f"uv pip install -q -r {req} || python -m pip install -q -r {req}", shell=True, capture_output=True, timeout=300)
        env = {k: v for k, v in E.items() if k in ("PATH", "HOME", "LANG", "VIRTUAL_ENV", "UV", "TMPDIR", "MOTHERDUCK_TOKEN",
                                                    "motherduck_token", "github_read_GITHUB_TOKEN", "openrouter_OPENROUTER_API_KEY")}
        env.update({"HEAL_DATA_DB": self.sandbox, "HEAL_SANDBOX": "1", "HEAL_PIPELINE": p, "HEAL_CHAOS_SNAPSHOT": self.chaos_snapshot(p),
                    "PYTHONPATH": str(self.proj), "HEAL_SHA": "working-tree", "HEAL_EVENTS_SINK": "log", "PYTHONUNBUFFERED": "1"})
        t = time.time()
        try:
            r = subprocess.run([sys.executable, "-u", str(self.proj / entry)], cwd=self.proj, env=env, capture_output=True, text=True, timeout=900)
            out, code = (r.stdout + r.stderr), r.returncode
        except subprocess.TimeoutExpired as e:
            out, code = f"{e.stdout or ''}{e.stderr or ''}\n(timed out after 900 s)", 124
        lines = [l for l in redact(out).splitlines() if not l.startswith("   +") and "Installed" not in l]
        evs = [l for l in lines if l.startswith("HEAL_EVENT") and '"severity": "info"' not in l]
        return {"pipeline": p, "exit": code, "seconds": round(time.time() - t, 1), "log_tail": "\n".join(lines[-60:])[-6000:],
                "events": evs[-10:]}

    # ---------------------------------------------------------------------------------- context
    def last_good_sha(self):
        row = self.con.execute(f"""SELECT sha FROM {S}.main.processed_runs WHERE component = ? AND status = 'SUCCEEDED' AND sha IS NOT NULL
                                   ORDER BY processed_at DESC LIMIT 1""", [self.pipeline]).fetchone()
        return row[0] if row else None

    def context_text(self):
        inc = self.inc
        evs = self.con.execute(f"""SELECT pipeline, error_class, norm_msg, raw_excerpt, run_number, sha, attach_reason, ts FROM {S}.main.events
                                   WHERE incident_id = ? ORDER BY event_id DESC LIMIT 8""", [self.incident_id]).fetchall()
        ev_txt = "\n\n".join(f"- [{e[7]:%Y-%m-%d %H:%M}] {e[0]} run {e[4]} sha {(e[5] or '-')[:10]} ({e[6]}): {e[1]}\n  normalized: {e[2]}\n  raw: {redact(e[3] or '')[:1500]}"
                             for e in evs)
        lg = self.last_good_sha()
        hist = ""
        if lg:
            try:
                hist = sh(["git", "-C", str(self.repo), "log", "--oneline", f"{lg}..HEAD", "--", f"{PROJ}/pipelines/{self.pipeline}"], check=False)
            except Exception:
                hist = ""
        p = registry()["pipelines"].get(self.pipeline, {})
        up = p.get("upstream", [])
        reg = ""
        if inc.get("guide_id") or self.mode == "revert":
            reg = f"\nThis incident REGRESSED: a previous fix (sha {inc.get('fix_sha') or '?'}) was merged and the same failure came back."
        return f"""incident {inc['incident_id']}: {inc['title']}
status {inc['status']} | class {inc['class']} | category {inc['category']} | severity {inc['severity']} | autonomy {self.level}
pipeline {self.pipeline}: {p.get('description', '')}
code: {PROJ}/pipelines/{self.pipeline}/ (main.py, tests.yaml, ops.yaml, requirements.txt, docs/api.md)
assets: {', '.join(p.get('assets', []))} | resources: {', '.join(p.get('resources', []))}
lineage: upstream {up or '-'}; downstream pipelines that showed symptoms: {self.downstream or '-'}
last green sha: {lg or 'unknown'}; current base {self.base_sha[:10]}; commits touching this pipeline since last green:
{hist or '(none)'}{reg}

failure events (newest first):
{ev_txt}

shared library: healkit/ (http.Http with opt-in retries/honor_retry_after/min_interval_s, tests.quarantine,
execute.execute guarded writes, pipeline.main(name, load, transactional=...)). Read it; don't change it.
"""

    def logs_text(self, run=None):
        row = self.con.execute(f"""SELECT flight_id, run_number FROM {S}.main.events WHERE incident_id = ? AND flight_id IS NOT NULL
                                   {'AND run_number = ?' if run else ''} ORDER BY event_id DESC LIMIT 1""",
                               [self.incident_id] + ([run] if run else [])).fetchone()
        if not row:
            return "no run logs for this incident"
        lines = list(reversed(flights.logs(self.con, str(row[0]), row[1], limit=150)))
        lines = [l for l in lines if not l.startswith("   +")]
        return redact(f"log of run {row[1]} (last 150 lines):\n" + "\n".join(lines))

    # --------------------------------------------------------------------------------- opencode
    def install_opencode(self):
        ver = (HERE / "opencode/VERSION").read_text().strip()
        dest = pathlib.Path(f"/tmp/opencode-{ver}/opencode")
        if not dest.exists():
            arch = {"x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}[platform.machine()]
            osn = "darwin" if sys.platform == "darwin" else "linux"
            ext = "zip" if osn == "darwin" else "tar.gz"
            url = f"https://github.com/anomalyco/opencode/releases/download/v{ver}/opencode-{osn}-{arch}.{ext}"
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.parent / f"oc.{ext}"
            urllib.request.urlretrieve(url, tmp)
            if ext == "zip":
                sh(["unzip", "-oq", str(tmp), "-d", str(dest.parent)])
            else:
                tarfile.open(tmp).extractall(dest.parent, filter="data")
            dest.chmod(0o755)
        got = sh([str(dest), "--version"]).strip()
        if got != ver:
            raise RuntimeError(f"opencode version {got} != pinned {ver}")
        self.opencode = str(dest)
        home = WORK / "home"
        cfgdir = home / ".config/opencode"
        cfgdir.mkdir(parents=True, exist_ok=True)
        cfg = (HERE / "opencode/opencode.json").read_text().replace("__MODEL__", self.model)
        (cfgdir / "opencode.json").write_text(cfg)
        bindir = WORK / "bin"
        bindir.mkdir(exist_ok=True)
        for tool in ("heal", "mdsql"):
            shutil.copy(HERE / "cli" / tool, bindir / tool)
            (bindir / tool).chmod(0o755)
        self.oc_env = {
            "PATH": f"{bindir}:/usr/local/bin:/usr/bin:/bin", "HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_DATA_HOME": str(home / ".local/share"), "XDG_CACHE_HOME": str(home / ".cache"), "LANG": "C.UTF-8",
            "OPENROUTER_API_KEY": llm.api_key(), "HEAL_BROKER_URL": f"http://127.0.0.1:{self.broker.port}",
            "HEAL_BROKER_TOKEN": self.broker.token, "PYTHONDONTWRITEBYTECODE": "1",
        }

    def run_opencode(self, message, session=None):
        """Run one opencode turn; stream JSON events; enforce budget, runtime and step caps."""
        cmd = [self.opencode, "run", "--format", "json", "--title", f"heal incident {self.incident_id}"]
        if session:
            cmd += ["--session", session]
        cmd.append(message)
        proc = subprocess.Popen(cmd, cwd=self.proj, env=self.oc_env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, start_new_session=True)
        stderr_buf = []
        threading.Thread(target=lambda: stderr_buf.extend(proc.stderr), daemon=True).start()
        steps, sid, texts, stop = 0, session, [], None
        try:
            for line in proc.stdout:
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                sid = sid or ev.get("sessionID")
                part = ev.get("part") or {}
                if ev.get("type") == "step_finish":
                    steps += 1
                    self.spend(part.get("cost") or 0, "opencode")
                    if steps >= self.max_steps:
                        raise Stop("step_cap", f"opencode step cap {self.max_steps} reached")
                elif ev.get("type") == "tool_use":
                    st = part.get("state") or {}
                    inp = st.get("input") or {}
                    cmdline = inp.get("command") or inp.get("filePath") or inp.get("pattern") or json.dumps(inp)[:300]
                    self.broker.action("tool", f"{part.get('tool')}: {cmdline}", st.get("status"),
                                       {"output": redact(str(st.get("output") or st.get("error") or ""))[:3000]})
                elif ev.get("type") == "text":
                    texts.append(part.get("text") or "")
                self.check_time()
                self.touch()
        except Stop as s:
            stop = s
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(10)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
        if stop:
            raise stop
        if proc.returncode not in (0, None, -15):
            print("opencode stderr:", redact("".join(stderr_buf))[-2000:], flush=True)
        return {"session": sid, "steps": steps, "text": "\n".join(texts)[-4000:]}

    # --------------------------------------------------------------------------------- approver
    def command_check(self, sql):
        system = ("You review one SQL statement an automated fixer wants to run in a sandbox clone of a data warehouse. "
                  "Approve unless it is destructive beyond what debugging/verification needs or targets something outside the "
                  'sandbox. Reply JSON {"verdict": "approve"|"deny", "why": "..."}')
        try:
            out, cost, _ = llm.chat_json(self.approver_model, system, sql[:4000], max_tokens=200)
        except Exception:
            return "deny"
        self.spend(cost, "command check")
        v = "approve" if out.get("verdict") == "approve" else "deny"
        self.broker.action("approver", f"command check: {sql[:300]}", v, out)
        return v

    def approve(self, diff, guard, sub):
        system = (HERE.parent / "prompts/approver.md").read_text()
        titles = dict(self.con.execute(f"SELECT guide_id::VARCHAR, title FROM {S}.main.guide_index").fetchall())
        links = [{**l, "title": titles.get(l["guide_id"], "?")} for l in (sub.get("helpful_guides") or [])]
        user = f"""## Task
Incident {self.incident_id} ({self.inc['class']}, category {self.inc['category']}) in pipeline {self.pipeline}: {self.inc['title']}
Autonomy level: {self.level}

## Failure evidence
{self.context_text()[:6000]}

## Reproduction (before the change)
{json.dumps(self.repro, default=str)[:5000]}

## Diff
```diff
{diff[:30000]}
```

## Verification (after the change)
{json.dumps(self.broker.last_verify, default=str)[:8000]}

## Deterministic guard report
{guards.render(guard)}

## Fixer's structured result
{json.dumps({k: sub.get(k) for k in ('symptoms', 'root_cause', 'fix_summary', 'verification', 'risk')}, indent=1)}

## Proposed helpful_guides
{json.dumps(links, indent=1)}
"""
        out, cost, _ = llm.chat_json(self.approver_model, system, user, max_tokens=3000, reasoning="high")
        self.spend(cost, "approver")
        verdict = "approve" if out.get("verdict") == "approve" else "deny"
        out["verdict"] = verdict
        self.broker.action("approver", "review", verdict, out)
        self.approver_log.append(out)
        return out

    def local_ci(self) -> tuple[str, str]:
        """Direct mode stand-in for the GitHub Actions workflow: compile, unit tests, registry check."""
        env = {**{k: v for k, v in E.items() if k in ("PATH", "HOME", "VIRTUAL_ENV", "UV", "TMPDIR", "LANG")}, "PYTHONPATH": str(self.proj)}
        steps = [[sys.executable, "-m", "compileall", "-q", "healkit", "healer", "pipelines", "scripts", "bootstrap"],
                 [sys.executable, "scripts/check_registry.py"]]
        subprocess.run("uv pip install -q pytest || python -m pip install -q pytest", shell=True, capture_output=True, timeout=300)
        steps.append([sys.executable, "-m", "pytest", "-q", "tests"])
        out = []
        for cmd in steps:
            r = subprocess.run(cmd, cwd=self.proj, env=env, capture_output=True, text=True, timeout=600)
            out.append(f"$ {' '.join(cmd[1:])} -> {r.returncode}\n{(r.stdout + r.stderr)[-800:]}")
            if r.returncode:
                return "failure", "\n".join(out)
        return "success", "\n".join(out)

    def direct_patch(self, title, body, level, status):
        """Record the fix as a patch (git diff against the base, paths relative to the repo root)."""
        patch = sh(["git", "-C", str(self.repo), "diff", "--cached", "--binary", self.base_sha, "--", PROJ])
        paths = [l for l in sh(["git", "-C", str(self.repo), "diff", "--cached", "--name-only", self.base_sha, "--", PROJ]).splitlines()]
        pid = self.con.execute(f"""INSERT INTO {S}.main.code_patches (incident_id, ref, base_sha, paths, patch, status, level, fixer_run_id, title, body,
                                   activated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'active' THEN now() END) RETURNING patch_id""",
                               [self.incident_id, self.base_branch, self.base_sha, paths, patch, status, level, self.run_id, title, body, status]).fetchone()[0]
        return pid

    # --------------------------------------------------------------------------------- github
    def push_pr(self, title, body, labels, draft=False):
        sh(["git", "-C", str(self.repo), "add", "-A", "--", PROJ])
        sh(["git", "-C", str(self.repo), "commit", "-q", "-m", title, "-m", f"Incident {self.incident_id}. Automated by the self-healing fixer."])
        sh(["git", "-C", str(self.repo), "push", "-q", "-f", "origin", self.branch], timeout=120)
        head = sh(["git", "-C", str(self.repo), "rev-parse", "HEAD"]).strip()
        pr = self.gh.create_pr(self.branch, self.base_branch, title, body, labels, draft=draft)
        return pr, head

    def merge_if_green(self, pr, head):
        state = self.gh.wait_checks(head, timeout_s=min(900, max(120, self.runtime_cap - (time.time() - self.t0) - 60)))
        if state != "success":
            return None, state
        m = self.gh.merge(pr["number"], head, title=f"{pr['title']} (#{pr['number']})")
        return m.get("sha"), state

    # ---------------------------------------------------------------------------------- flows
    def revert(self):
        sha = self.inc.get("fix_sha")
        if not sha:
            raise Stop("escalated", "regressed but no fix sha recorded to revert")
        if sha.startswith("direct:"):
            pid = int(sha.split(":")[1])
            if self.level == "L3":
                raise Stop("proposed", f"L3: revert of direct patch {pid} proposed (set code_patches.status = 'reverted' to apply)")
            self.con.execute(f"UPDATE {S}.main.code_patches SET status = 'reverted', reverted_at = now(), reason = ? WHERE patch_id = ?",
                             [f"incident {self.incident_id} regressed", pid])
            self.con.execute(f"UPDATE {S}.main.incidents SET fix_sha = NULL WHERE incident_id = ?", [self.incident_id])
            self.broker.action("note", f"reverted direct patch {pid}", "ok")
            print(f"reverted direct patch {pid}; retrying the fix from the reverted base", flush=True)
            self.mode = "fix"
            self.setup_repo()
            return True
        sh(["git", "-C", str(self.repo), "fetch", "-q", "--deepen", "200"], check=False)
        r = subprocess.run(["git", "-C", str(self.repo), "revert", "--no-edit", sha], capture_output=True, text=True)
        if r.returncode:
            raise Stop("escalated", f"automatic revert of {sha[:10]} failed: {r.stderr[-300:]}")
        title = f"heal: revert {sha[:10]} (incident {self.incident_id} regressed)"
        body = (f"The fix for incident {self.incident_id} (`{sha}`) regressed: the same failure fingerprint recurred after it "
                f"was merged.\n\nThis PR reverts it. The fixer then retries the incident.")
        labels = ["heal", f"incident:{self.incident_id}", f"level:{self.level}", f"category:{self.inc['category']}", "heal:revert"]
        pr, head = self.push_pr(title, body, labels)
        if self.level in ("L1", "L2"):
            merged, state = self.merge_if_green(pr, head)
            if not merged:
                raise Stop("escalated", f"revert PR #{pr['number']} not merged (CI {state})")
            self.con.execute(f"UPDATE {S}.main.incidents SET fix_sha = NULL WHERE incident_id = ?", [self.incident_id])
            lifecycle.sync_issue(self.con, self.incident_id, f"Reverted the regressed fix via #{pr['number']} ({merged[:10]}). Retrying.")
            # Continue from the reverted base on a fresh branch.
            sh(["git", "-C", str(self.repo), "fetch", "-q", "origin", self.base_branch])
            sh(["git", "-C", str(self.repo), "checkout", "-q", "-B", f"heal/{self.incident_id}-a{self.attempt}", f"origin/{self.base_branch}"])
            self.branch = f"heal/{self.incident_id}-a{self.attempt}"
            self.base_sha = sh(["git", "-C", str(self.repo), "rev-parse", "HEAD"]).strip()
            self.base_tree = sh(["git", "-C", str(self.repo), "rev-parse", "HEAD^{tree}"]).strip()
            self.mode = "fix"
            return True
        raise Stop("proposed", f"L3: revert proposed in PR #{pr['number']}")

    def prompt(self):
        extra = ""
        if self.mode == "category_proposal":
            rows = self.con.execute(f"""SELECT incident_id, title, class, pipeline FROM {S}.main.incidents WHERE category = 'other'
                                        AND status = 'resolved' ORDER BY incident_id DESC LIMIT 20""").fetchall()
            extra = ("\n## Special task: category proposal\nSeveral resolved incidents landed in the `other` Guide category:\n"
                     + "\n".join(f"- #{r[0]} {r[1]} (class {r[2]}, {r[3]})" for r in rows)
                     + "\nPropose ONE new category (or a new class mapping) in `healer/memory/categories.yaml` that would hold "
                       "them. Keep 5-10 categories plus `other`; if that would exceed 10, merge two existing categories instead. "
                       "This is always an L3 proposal for a human. No `heal verify` needed; `heal submit` still required.")
        level_rules = {"L1": "- Autonomy L1: if approved and CI is green, your change merges automatically.",
                       "L2": "- Autonomy L2: destructive ops outside the op profile turn the fix into a proposal for a human.",
                       "L3": "- Autonomy L3: your change becomes a PR for a human to review."}[self.level]
        return (HERE.parent / "prompts/fixer.md").read_text().format(
            incident_summary=self.context_text()[:5000] + (f"\nReproduction in the sandbox (before any change):\n{self.repro_summary()}" if self.repro else ""),
            pipeline=self.pipeline, level_rules=level_rules, extra=extra)

    def repro_summary(self):
        return "\n".join(f"- {r['pipeline']}: exit {r['exit']}\n{r['log_tail'][-1500:]}" for r in self.repro["runs"])

    def fix(self):
        if self.mode != "category_proposal" and not self.healer_incident:
            self.repro = self.broker.run("repro")
            if self.repro["ok"]:
                raise Stop("escalated", "could not reproduce the failure in the sandbox at the current code")
        self.shortlist = guides.shortlist(self.con, {**self.inc, "norm_msg": self.inc["title"]})
        self.playbook_id = guides.playbook(self.con, self.inc["category"])
        msg, session = self.prompt(), None
        approved, rounds_used, guard = None, 0, None
        for turn in range(self.rounds + 3):
            res = self.run_opencode(msg, session)
            session = res["session"] or session
            sub = self.broker.submission
            if not sub:
                msg = ("You stopped without an accepted `heal submit`. Finish the task: get `heal verify` green on your final "
                       "code, write heal_result.json and run `heal submit heal_result.json`.")
                continue
            guard = guards.report(str(self.repo), self.base_sha, self.pipeline, self.level, self.healer_incident or self.mode == "category_proposal")
            self.broker.action("guard", "guard report", "ok" if guard["ok"] else "violations", guard)
            if not guard["ok"]:
                self.broker.submission = None
                msg = "The deterministic guard rejected the change:\n" + "\n".join(f"- {v}" for v in guard["violations"]) + \
                      "\nRevise the change so none of these apply, re-run `heal verify`, and `heal submit` again."
                continue
            if rounds_used > self.rounds:
                break
            rounds_used += 1
            diff = sh(["git", "-C", str(self.repo), "diff", "--cached", self.base_sha, "--", PROJ])
            appr = self.approve(diff, guard, sub)
            if appr["verdict"] == "approve":
                approved = appr
                break
            if rounds_used > self.rounds:
                break
            self.broker.submission = None
            msg = (f"The independent approver denied the change (round {rounds_used}/{self.rounds}). Its feedback:\n\n"
                   f"{appr.get('feedback')}\n\nAddress it, re-run `heal verify`, and `heal submit` again.")
        self.con.execute(f"UPDATE {S}.main.fixer_runs SET approver_rounds = ? WHERE fixer_run_id = ?", [rounds_used, self.run_id])
        return approved, guard, self.broker.submission

    def finish(self, approved, guard, sub):
        inc = self.inc
        if not sub:
            raise Stop("escalated", "the fixer did not produce an accepted result")
        kept, dropped = guides.validate_links(self.con, self.incident_id, self.run_id, sub.get("helpful_guides"))
        removed = set((approved or {}).get("removed_links") or [])
        links = [l for l in kept if l["guide_id"] not in removed]
        level = self.level
        downgrade = ""
        if approved and level == "L2" and guard["l2_blocks"]:
            level, downgrade = "L3", "L2 guards blocked: " + "; ".join(guard["l2_blocks"])
        diffstat = sh(["git", "-C", str(self.repo), "diff", "--cached", "--stat", self.base_sha, "--", PROJ])
        appr_txt = json.dumps(approved or (self.approver_log[-1] if self.approver_log else {}), indent=1)
        title = f"heal: {self.pipeline} - {sub['fix_summary'][:80]} (incident {self.incident_id})"
        body = f"""Automated fix from the self-healing fixer. Incident #{self.incident_id}{f' / issue #{inc["gh_issue"]}' if inc.get('gh_issue') else ''}.

**Category / class:** `{inc['category']}` / `{inc['class']}` · **Autonomy:** `{level}`{f' (downgraded: {downgrade})' if downgrade else ''} · **Cost:** ${self.cost:.2f}

### Root cause
{sub['root_cause']}

### Fix
{sub['fix_summary']}

### Reproduction (before)
```
{self.repro_summary()[-2500:] if self.repro else 'n/a'}
```

### Verification (after)
{sub['verification']}

```
{json.dumps((self.broker.last_verify or {}).get('datadiff'), indent=1, default=str)[:3000]}
```

### Guard report
{guards.render(guard)}

### Approver ({self.approver_model}) verdict: **{(approved or {}).get('verdict', 'deny')}**
```
{appr_txt[:3000]}
```

### Helpful Guides
{chr(10).join(f"- `{l['guide_id']}` v{l['version']} — {l['how_used']}: {l['reason']}" for l in links) or '_none_'}
{('Dropped by validation: ' + '; '.join(f"`{d.get('guide_id')}` ({d['dropped_because']})" for d in dropped)) if dropped else ''}

<sub>diffstat</sub>

```
{diffstat[-1500:]}
```
"""
        labels = ["heal", f"incident:{self.incident_id}", f"level:{level}", f"category:{inc['category']}"]
        if GH_MODE == "direct":
            return self.finish_direct(approved, level, title, body, sub, links, dropped, diffstat, appr_txt, downgrade)
        pr, head = self.push_pr(title, body, labels, draft=not approved)
        draft = {"summary": f"{inc['class'].replace('_', ' ')} in {self.pipeline}: {sub['root_cause'][:300]}",
                 "symptoms": sub["symptoms"], "root_cause": sub["root_cause"],
                 "fix": f"{sub['fix_summary']}\n\nPR #{pr['number']}.\n\n```\n{diffstat[-800:]}\n```",
                 "verification": sub["verification"], "approver_notes": (approved or {}).get("notes") or (approved or {}).get("feedback") or "",
                 "validated_links": links, "dropped_links": dropped, "assets": sub.get("assets") or registry()["pipelines"].get(self.pipeline, {}).get("assets", [])}
        self.con.execute(f"UPDATE {S}.main.fixer_runs SET pr_number = ?, branch = ?, summary = ?::JSON WHERE fixer_run_id = ?",
                         [pr["number"], self.branch, json.dumps(draft, default=str), self.run_id])
        self.con.execute(f"UPDATE {S}.main.incidents SET gh_pr = ? WHERE incident_id = ?", [pr["number"], self.incident_id])
        if not approved:
            if self.approver_log:
                self.gh.comment(pr["number"], f"Approver denied after {len(self.approver_log)} rounds:\n```\n{appr_txt[:5000]}\n```")
            raise Stop("escalated", f"approver denied after {len(self.approver_log)} rounds; draft PR #{pr['number']}")
        if level in ("L1", "L2"):
            merged, state = self.merge_if_green(pr, head)
            if merged:
                lifecycle.transition(self.con, self.incident_id, "merged", f"PR #{pr['number']} approved, CI {state}, merged as {merged[:10]}",
                                     actor="fixer", fix_sha=merged, merged_at="now()", lease_owner=None)
                return "merged"
            lifecycle.transition(self.con, self.incident_id, "proposed", f"PR #{pr['number']} approved but CI {state}; left for a human",
                                 actor="fixer", lease_owner=None)
            return "proposed"
        self.gh.comment(pr["number"], f"L3 proposal. Approver review:\n```\n{appr_txt[:5000]}\n```")
        lifecycle.transition(self.con, self.incident_id, "proposed", f"L3 proposal PR #{pr['number']}{' (' + downgrade + ')' if downgrade else ''}",
                             actor="fixer", lease_owner=None)
        return "proposed"



    def finish_direct(self, approved, level, title, body, sub, links, dropped, diffstat, appr_txt, downgrade):
        status = "active" if approved and level in ("L1", "L2") else ("proposed" if approved else "denied")
        ci = ("n/a", "")
        if status == "active":
            ci = self.local_ci()
            if ci[0] != "success":
                status = "proposed"
        pid = self.direct_patch(title, body + f"\n\n### Local CI: {ci[0]}\n```\n{ci[1][-2000:]}\n```", level, status)
        draft = {"summary": f"{self.inc['class'].replace('_', ' ')} in {self.pipeline}: {sub['root_cause'][:300]}",
                 "symptoms": sub["symptoms"], "root_cause": sub["root_cause"],
                 "fix": f"{sub['fix_summary']}\n\nDirect patch {pid} (no GitHub write access yet).\n\n```\n{diffstat[-800:]}\n```",
                 "verification": sub["verification"], "approver_notes": (approved or {}).get("notes") or (approved or {}).get("feedback") or "",
                 "validated_links": links, "dropped_links": dropped,
                 "assets": sub.get("assets") or registry()["pipelines"].get(self.pipeline, {}).get("assets", [])}
        self.con.execute(f"UPDATE {S}.main.fixer_runs SET branch = ?, summary = ?::JSON WHERE fixer_run_id = ?",
                         [f"direct:{pid}", json.dumps(draft, default=str), self.run_id])
        print(f"direct patch {pid}: {status} (level {level}, local CI {ci[0]})\n{diffstat}", flush=True)
        if status == "denied":
            raise Stop("escalated", f"approver denied after {len(self.approver_log)} rounds; draft kept as patch {pid}")
        if status == "active":
            lifecycle.transition(self.con, self.incident_id, "merged", f"approved, local CI green, direct patch {pid} active",
                                 actor="fixer", fix_sha=f"direct:{pid}", merged_at="now()", lease_owner=None)
            return "merged"
        why = f"L3 proposal: direct patch {pid}" + (f" ({downgrade})" if downgrade else "") + ("" if ci[0] in ("n/a", "success") else f"; local CI {ci[0]}")
        lifecycle.transition(self.con, self.incident_id, "proposed", why, actor="fixer", fix_sha=f"direct:{pid}", lease_owner=None)
        return "proposed"


def main():
    fx = None
    outcome, why = "failed", ""
    try:
        fx = Fixer()
        fx.claim()
        print(f"fixer {fx.run_id}: incident {fx.incident_id} {fx.inc['class']} in {fx.pipeline}, level {fx.level}, mode {fx.mode}", flush=True)
        fx.setup_repo()
        fx.broker = Broker(fx)
        fx.install_opencode()
        if fx.mode == "revert":
            fx.revert()
        approved, guard, sub = fx.fix()
        outcome = fx.finish(approved, guard, sub)
        why = outcome
    except Stop as s:
        outcome, why = s.outcome, s.why
        print(f"fixer stop: {s.outcome}: {s.why}", flush=True)
        if fx and fx.inc and s.outcome in ("escalated",):
            lifecycle.transition(fx.con, fx.incident_id, "escalated", s.why, actor="fixer", lease_owner=None)
        elif fx and fx.inc and s.outcome == "proposed":
            lifecycle.transition(fx.con, fx.incident_id, "proposed", s.why, actor="fixer", lease_owner=None)
        elif fx and fx.inc and s.outcome in ("over_budget", "runtime_cap", "step_cap", "killed"):
            # Release the lease; the checker re-dispatches (attempt+1) or escalates after max attempts.
            fx.con.execute(f"UPDATE {S}.main.incidents SET lease_expires = now() - INTERVAL 1 SECOND, lease_owner = NULL WHERE incident_id = ?",
                           [fx.incident_id])
            lifecycle.sync_issue(fx.con, fx.incident_id, f"Fixer attempt {fx.attempt} stopped: {s.why}")
    except Exception as e:
        traceback.print_exc()
        why = f"{type(e).__name__}: {redact(str(e))[:500]}"
        if fx and getattr(fx, "inc", None):
            fx.con.execute(f"UPDATE {S}.main.incidents SET lease_expires = now() - INTERVAL 1 SECOND, lease_owner = NULL WHERE incident_id = ?",
                           [fx.incident_id])
    finally:
        if fx and getattr(fx, "con", None) and getattr(fx, "run_id", None):
            fx.drop_sandbox()
            fx.con.execute(f"""UPDATE {S}.main.fixer_runs SET ended_at = now(), status = ?, outcome = ?, cost_usd = ? WHERE fixer_run_id = ?""",
                           ["done" if outcome in ("merged", "proposed", "escalated", "noop") else "failed", outcome, round(fx.cost, 4), fx.run_id])
            fx.con.execute(f"UPDATE {S}.main.incidents SET cost_usd = cost_usd + ? WHERE incident_id = ?", [round(fx.cost, 4), fx.incident_id])
            print(f"fixer done: outcome={outcome} cost=${fx.cost:.2f} in {time.time() - fx.t0:.0f}s ({why})", flush=True)
    sys.exit(0 if outcome in ("merged", "proposed", "escalated", "noop") else 1)


if __name__ == "__main__":
    main()

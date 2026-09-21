"""One board keeps one Dive: how `publisher` finds the Dive a board already owns.

No warehouse here — the lookup order is the contract, so it runs against a stub that keeps a
small world of Dives and answers the queries `_find_dive` and `_upsert` ask, `LIKE` included.
The live behaviour (a `dbt build` publishing 12 boards, then again with the registry dropped,
without creating a duplicate) is exercised by the dbt v2 example project.
"""

from __future__ import annotations

import re

from dbt_charts_dive import config as C, publisher as P

KEY = "analytics:sales"
_BUILT = {"title": "Sales", "description": "", "content": "// dive", "required_resources": []}


def _like(pattern: str, text: str) -> bool:
    """SQL LIKE, so a test can see what a `%` or a `_` in a key really matches."""
    return re.fullmatch(re.escape(pattern).replace("%", ".*").replace("_", "."), text or "", re.S) is not None


class StubCon:
    """A handful of Dives, a registry table, and the queries the publisher puts to them."""

    def __init__(self, *, registry=None, dives=(), registry_alive=True, on_create=None):
        self.registry = dict(registry or {})  # dive_key -> dive_id
        self.dives = [dict(d) for d in dives]  # {"id", "title", "description"}
        self.registry_alive = registry_alive  # whether the Dive a registry row names still exists
        self.on_create = on_create  # what another run did in the meantime
        self.vars: dict[str, str] = {}
        self.asked: list[str] = []
        self.written: list[tuple[str, list]] = []
        self.deleted: list[str] = []
        self._last: list[tuple] = []

    def dive(self, key: str) -> dict:
        """The Dive this package would recognize as the board's, by its marker."""
        return next(d for d in self.dives if d["description"].endswith(f"{P.MARKER} {key}"))

    def execute(self, sql, params=None):
        self.asked.append(sql)
        params = list(params or [])
        if sql.startswith("SET VARIABLE"):
            self.vars[sql.split()[2]] = params[0]
            self._last = []
        elif sql.split(" ", 1)[0] in ("DELETE", "INSERT", "CREATE"):
            self.written.append((sql, params))
            self._last = []
        elif "SELECT dive_id" in sql:
            found = self.registry.get(params[0])
            self._last = [(found,)] if found else []
        elif "MD_GET_DIVE" in sql:
            alive = self.registry_alive and any(d["id"] == self.vars["dcd_id"] for d in self.dives)
            self._last = [(1 if alive or self.registry_alive else 0,)]
        elif "MD_CREATE_DIVE" in sql:
            if self.on_create:
                self.on_create(self)
            self.dives.append({"id": "new-1", "title": self.vars["dcd_title"], "description": self.vars["dcd_description"]})
            self._last = [("new-1",)]
        elif "MD_DELETE_DIVE" in sql:
            self.deleted.append(self.vars["dcd_id"])
            self.dives = [d for d in self.dives if d["id"] != self.vars["dcd_id"]]
            self._last = []
        elif "ends_with(description" in sql:
            self._last = [(d["id"],) for d in self.dives if d["description"].endswith(self.vars["dcd_marker"])]
        elif "description LIKE" in sql:
            self._last = [(d["id"],) for d in self.dives if _like(self.vars["dcd_marker"], d["description"])]
        elif "title = " in sql:
            self._last = [(d["id"],) for d in self.dives if d["title"] == self.vars["dcd_title_lookup"]]
        else:
            self._last = []
        return self

    def fetchone(self):
        return self._last[0] if self._last else None

    def fetchall(self):
        return self._last


def marked(key: str, body: str = "") -> dict:
    return {"id": f"dive-{key}", "title": "Sales", "description": P.described(body, key)}


def find(con: StubCon, key: str = KEY, title: str = "Sales", legacy_key: str | None = None):
    return P._find_dive(con, "registry", key, title, legacy_key=legacy_key)[0]


def test_registry_wins():
    con = StubCon(registry={KEY: "reg-1"}, dives=[marked(KEY)])
    assert find(con) == "reg-1"
    assert not any("ends_with" in q for q in con.asked), "no need to look further"


def test_marker_found_when_the_registry_is_empty():
    con = StubCon(dives=[marked(KEY)])
    assert find(con) == f"dive-{KEY}"


def test_marker_found_when_the_registry_points_at_a_deleted_dive():
    con = StubCon(registry={KEY: "reg-1"}, dives=[marked(KEY)], registry_alive=False)
    assert find(con) == f"dive-{KEY}"


def test_nothing_found_means_create():
    assert find(StubCon()) is None


def test_a_dive_with_the_same_title_is_left_alone():
    """The title used to be the last resort, and it reached any Dive in the account —
    including one a person made by hand that happens to be called what this board is."""
    con = StubCon(dives=[{"id": "someone-elses", "title": "Sales", "description": "my own dashboard"}])
    assert find(con) is None


def test_the_marker_matches_one_key_exactly():
    """`LIKE '%dbt_charts_dive: analytics:sales%'` also matches `analytics:sales_old`."""
    con = StubCon(dives=[marked("analytics:sales_old")])
    assert find(con) is None


def test_a_key_that_looks_like_a_pattern_matches_only_itself():
    con = StubCon(dives=[marked("analytics:sales_2024")])
    assert find(con, key="analytics:sales_2024") == "dive-analytics:sales_2024"
    assert find(con, key="analytics:salesX2024") is None


def test_the_marker_is_appended_to_the_description():
    assert P.described("Board notes", KEY) == f"Board notes\n\n{P.MARKER} {KEY}"
    assert P.described("", KEY) == f"{P.MARKER} {KEY}"


# ── one database, two projects ────────────────────────────────────────────────
def _project(root, name: str, board: str = "sales.yml"):
    """A minimal dbt project with one board, at ``charts/<board>``."""
    (root / "charts").mkdir(parents=True)
    (root / "dbt_project.yml").write_text(f"name: {name}\nversion: '1.0'\n", encoding="utf-8")
    (root / "charts" / board).write_text("title: Sales\nsource: s\ncharts: {}\n", encoding="utf-8")
    return root


def _key(root, **options):
    return C.plan(root, C.load_options(root, options), [])[0]["key"]


def test_two_projects_with_the_same_board_path_own_different_dives(tmp_path):
    """Both projects run against one MotherDuck database, so one board path is not a name."""
    assert _key(_project(tmp_path / "a", "analytics")) != _key(_project(tmp_path / "b", "marketing"))


def test_a_project_can_name_its_own_namespace(tmp_path):
    """Two dbt projects can share a `name:`; `dive: {project: ...}` tells them apart."""
    assert _key(_project(tmp_path / "a", "analytics"), project="eu") == "eu:sales"


def test_a_dive_published_before_the_project_prefix_is_adopted(tmp_path):
    """Upgrading must not leave a second Dive behind for every board."""
    root = _project(tmp_path / "a", "analytics")
    board = C.plan(root, C.load_options(root), [])[0]
    con = StubCon(dives=[marked(board["legacy_key"])])
    assert find(con, key=board["key"], legacy_key=board["legacy_key"]) == f"dive-{board['legacy_key']}"


def test_the_current_key_beats_a_legacy_registry_row():
    """A leftover bare-key row may point at a Dive another project has already adopted; this
    board's own marker is the better answer."""
    con = StubCon(registry={"sales": "legacy-row"}, dives=[marked(KEY), {"id": "legacy-row", "title": "x", "description": ""}])
    assert find(con, legacy_key="sales") == f"dive-{KEY}"


def test_a_legacy_row_this_board_did_not_use_is_left_alone():
    """Deleting it would take it from whoever it belongs to."""
    con = StubCon(registry={KEY: "mine"}, dives=[{"id": "mine", "title": "Sales", "description": P.described("", KEY)}])
    P._upsert(con, "registry", KEY, _BUILT, legacy_key="sales")
    assert [params for sql, params in con.written if sql.startswith("DELETE")] == [[KEY]]


def test_an_adopted_legacy_row_is_cleaned_up():
    con = StubCon(dives=[marked("sales")])
    P._upsert(con, "registry", KEY, _BUILT, legacy_key="sales")
    assert [params for sql, params in con.written if sql.startswith("DELETE")] == [[KEY, "sales"]]


# ── two runs, one board ───────────────────────────────────────────────────────
def test_two_runs_that_both_create_converge_on_one_dive():
    """Two dbt runs can publish a board for the first time at once: both look, both find
    nothing, both create, and the board owns two Dives from then on."""
    con = StubCon(on_create=lambda c: c.dives.append(marked(KEY)))
    dive_id, action = P._upsert(con, "registry", KEY, _BUILT)
    assert dive_id == f"dive-{KEY}" and action == "updated"
    assert con.deleted == ["new-1"], "the Dive this run created is the one to withdraw"


def test_a_board_that_is_gone_is_reported_not_deleted():
    """Its Dive is still somebody's link: say so and leave it."""
    assert P.orphaned([KEY], [KEY, "analytics:old"]) == ["analytics:old"]


# ── a board is only as fresh as the models it reads ───────────────────────────
def test_a_ref_only_a_partial_names_still_blocks_publication():
    """Planning reads the board's own text, and a board that `extends:` a partial names no
    model at all there. The compiler resolves the ref either way, so ask it."""
    import harness as H

    project = H.project_dir()
    built = C.build(project, "charts/e2e_fixtures/extends_base.yml", C.load_options(project))
    assert built["refs"] == ["fct_orders"]
    assert P.stale_refs(built["refs"], ["fct_orders", "other"]) == ["fct_orders"]
    assert P.stale_refs(built["refs"], ["other"]) == []


# ── one run, one set of Dives ─────────────────────────────────────────────────
def _two_boards(tmp_path, monkeypatch):
    root = _project(tmp_path / "p", "analytics")
    (root / "charts" / "costs.yml").write_text("title: Costs\nsource: s\ncharts: {}\n", encoding="utf-8")

    def build(project_dir, board_path, options):
        if board_path.endswith("costs.yml"):
            raise RuntimeError("costs.yml: the query is broken")
        return {**_BUILT, "refs": []}

    monkeypatch.setattr(C, "build", build)
    return root


def test_one_board_failing_publishes_none_of_them(tmp_path, monkeypatch):
    """Boards are published one after another, so a failure halfway leaves the dashboards
    half updated — and the build fails, telling nobody which half."""
    root = _two_boards(tmp_path, monkeypatch)
    con = StubCon()
    results = P.publish(root, con, database="db", schema="main", options=C.load_options(root), failed=[], log=lambda m: None)
    assert con.dives == [], "nothing is published when one board cannot be built"
    assert [r.get("error") or r.get("skipped") for r in results] == ["RuntimeError: costs.yml: the query is broken", "another board in this run failed"]


def test_a_project_can_ask_for_the_boards_that_do_work(tmp_path, monkeypatch):
    root = _two_boards(tmp_path, monkeypatch)
    con = StubCon()
    options = C.load_options(root, {"all_or_nothing": False})
    results = P.publish(root, con, database="db", schema="main", options=options, failed=[], log=lambda m: None)
    assert [d["title"] for d in con.dives] == ["Sales"]
    assert [r.get("error") for r in results] == ["RuntimeError: costs.yml: the query is broken", None]

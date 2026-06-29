import { useSQLQuery, useDiveState } from "@motherduck/react-sql-query";
import { N, rows, pct, STORY, INK, ARM, PATH, SERIF, SANS, MONO, Head, Figure, Loading, BarCell, Rule, Tip, noteFor, sel, td, tdL, th, thL } from "./lib";

const pathColor = (p: string) => (p === "sql" ? PATH.sql : p === "view" ? "#0a6aa8" : p === "authored" ? "#7ba6c4" : PATH.other);

export default function MetricsTab() {
  const matrix = useSQLQuery(`SELECT run_label, arm, n, correct, acc_pct, hard_acc, easy_acc, pct_sql, pct_malloy,
      round(median_prompt_tokens) AS tok, round(cost_usd,2) AS cost, escalations
    FROM "agentic_malloy_story"."main"."runs" WHERE split='test' ORDER BY arm DESC, acc_pct DESC`);
  const overfit = useSQLQuery(`SELECT tier, split, round(avg(acc_pct),1) AS avg_acc, count(*) AS runs
    FROM "agentic_malloy_story"."main"."runs" WHERE arm='malloy' AND layer_label='committed' AND tier IN ('sonnet+opus','gemini')
    GROUP BY tier, split ORDER BY tier, split DESC`);

  const m = rows(matrix.data);

  // ── ACI three-story side-by-side ──
  const [task, setTask] = useDiveState<string>("aci_task", "1443");
  const aciTasks = useSQLQuery(`SELECT task_id FROM "agentic_malloy_story"."main"."tasks" WHERE family='aci_most_expensive_template' ORDER BY TRY_CAST(task_id AS INT)`);
  const story3 = useSQLQuery(`SELECT run_label, arm, answer_path, is_correct, predicted, gold,
      coalesce(malloy_source, compiled_sql) AS code
    FROM "agentic_malloy_story"."main"."results"
    WHERE task_id='${task}' AND run_label IN
      ('Baseline · markdown+SQL (gemini)','Malloy · sonnet+opus · official (pre-fix)','Malloy · sonnet+opus · official')
    ORDER BY CASE WHEN arm='baseline' THEN 0 WHEN run_label LIKE '%pre-fix%' THEN 1 ELSE 2 END`);
  const cards = rows(story3.data);
  const cardTitle = (r: any) => r.arm === "baseline" ? "Baseline — SUM (markdown+SQL)"
    : String(r.run_label).includes("pre-fix") ? "Malloy — the AVG layer view" : "Malloy — bailed to SQL";

  // ── results explorer ──
  const PAGE = 20;
  const [run, setRun] = useDiveState<string>("ex_run", "Malloy · sonnet+opus · official");
  const [level, setLevel] = useDiveState<string>("ex_level", "all");
  const [path, setPath] = useDiveState<string>("ex_path", "all");
  const [correct, setCorrect] = useDiveState<string>("ex_correct", "all");
  const [onlyAF, setOnlyAF] = useDiveState<string>("ex_af", "no");
  const [page, setPage] = useDiveState<number>("ex_page", 0);
  const runOpts = m.map((r) => String(r.run_label));
  const w: string[] = [`r.run_label='${run.replace(/'/g, "''")}'`];
  if (level !== "all") w.push(`r.level='${level}'`);
  if (path !== "all") w.push(`r.answer_path='${path}'`);
  if (correct !== "all") w.push(`r.is_correct=${correct === "correct"}`);
  if (onlyAF === "yes") w.push(`t.always_fail`);
  const where = w.join(" AND ");
  const countQ = useSQLQuery(`SELECT count(*) AS n FROM "agentic_malloy_story"."main"."results" r JOIN "agentic_malloy_story"."main"."tasks" t USING (task_id) WHERE ${where}`);
  const total = N(rows(countQ.data)[0]?.n);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const cur = Math.min(Math.max(0, page), pages - 1);
  const explorer = useSQLQuery(`SELECT r.task_id, r.level, t.family, r.answer_path, r.is_correct, r.predicted, t.gold_result AS gold
    FROM "agentic_malloy_story"."main"."results" r JOIN "agentic_malloy_story"."main"."tasks" t USING (task_id)
    WHERE ${where} ORDER BY r.is_correct, TRY_CAST(r.task_id AS INT) LIMIT ${PAGE} OFFSET ${cur * PAGE}`);
  const ex = rows(explorer.data);
  const pBtn = (off: boolean): React.CSSProperties => ({ fontFamily: SANS, fontSize: 11, padding: "2px 9px", borderRadius: 4, border: `1px solid ${INK.rule}`, background: INK.paper, color: off ? INK.faint : ARM.malloy, cursor: off ? "default" : "pointer" });
  const setFilter = (fn: (v: string) => void) => (v: string) => { fn(v); setPage(0); };

  const of = rows(overfit.data);
  const ofRow = (tier: string, split: string) => of.find((r) => r.tier === tier && r.split === split);

  return (
    <div>
      {/* ── matrix ── */}
      <Head kicker="every number queried live" title="The run matrix">All six Malloy configurations and the baseline, on the same 419-task held-out set and DABstep scorer.</Head>
      <Figure caption={<>Accuracy and the share of answers the agent submitted as <b style={{ color: PATH.sql }}>raw SQL</b> rather than Malloy. The “best” Malloy run leans on SQL for the majority of answers.</>}>
        {matrix.isLoading ? <Loading label="loading runs…" /> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640 }}>
              <thead><tr>
                <th style={thL}>Substrate / run</th><th style={th}>Accuracy</th><th style={th}>Hard</th><th style={th}>Easy</th>
                <th style={th}>% via SQL</th><th style={th}>Med tok</th><th style={th}>Cost</th>
              </tr></thead>
              <tbody>
                {m.map((r) => {
                  const base = r.arm === "baseline";
                  return (
                    <tr key={String(r.run_label)} style={{ background: base ? "#eef3e8" : "transparent" }}>
                      <td style={{ ...tdL, fontWeight: base ? 700 : 400, color: base ? ARM.baseline : INK.text }}><Tip text={noteFor(String(r.run_label))}>{String(r.run_label)}</Tip></td>
                      <td style={td}><BarCell value={N(r.acc_pct)} color={base ? ARM.baseline : ARM.malloy} label={pct(r.acc_pct)} /></td>
                      <td style={td}>{pct(r.hard_acc)}</td>
                      <td style={td}>{N(r.easy_acc) ? pct(r.easy_acc) : "—"}</td>
                      <td style={td}><BarCell value={N(r.pct_sql)} color={PATH.sql} label={base ? "—" : `${N(r.pct_sql).toFixed(0)}%`} /></td>
                      <td style={td}>{N(r.tok).toLocaleString()}</td>
                      <td style={td}>${N(r.cost)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Figure>

      <Rule />

      {/* ── ACI three-story ── */}
      <Head kicker="the template that always failed" title="A fee-ranking question, three ways to be wrong">
        “Which routing code costs the most for a transaction?” The layer ranks by the AVERAGE rule fee; the right answer SUMs the fees a transaction actually incurs — so the view is wrong regardless of model. The same task, three ways:
      </Head>
      <div style={{ marginBottom: 12, fontFamily: SANS }}>
        <span style={{ fontSize: 12, color: INK.muted, marginRight: 8 }}>task</span>
        <select value={task} onChange={(e) => setTask(e.target.value)} style={{ ...sel, fontFamily: MONO }}>
          {rows(aciTasks.data).map((t) => <option key={String(t.task_id)} value={String(t.task_id)}>{String(t.task_id)}</option>)}
        </select>
      </div>
      {story3.isLoading ? <Loading label="loading…" /> : (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {cards.map((r) => {
            const good = r.is_correct;
            return (
              <div key={String(r.run_label)} style={{ flex: "1 1 260px", border: `1px solid ${INK.rule}`, borderTop: `3px solid ${pathColor(String(r.answer_path))}`, background: INK.paper }}>
                <div style={{ padding: "8px 11px" }}>
                  <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 12.5, color: INK.text }}>{cardTitle(r)}</div>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: INK.muted, marginTop: 2 }}>
                    submitted as <b style={{ color: pathColor(String(r.answer_path)) }}>{String(r.answer_path)}</b> ·
                    predicted <b style={{ fontFamily: MONO }}>{String(r.predicted)}</b> vs gold <b style={{ fontFamily: MONO }}>{String(r.gold)}</b>{" "}
                    <span style={{ color: good ? ARM.baseline : PATH.sql, fontWeight: 700 }}>{good ? "✓" : "✗"}</span>
                  </div>
                </div>
                <pre style={{ margin: 0, padding: 11, fontFamily: MONO, fontSize: 10, color: INK.text, background: INK.panel, borderTop: `1px solid ${INK.rule}`, overflowX: "auto", maxHeight: 200, whiteSpace: "pre-wrap" }}>
                  {String(r.code ?? "(none)").slice(0, 1100)}
                </pre>
              </div>
            );
          })}
        </div>
      )}
      <p style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 12.5, color: INK.muted, marginTop: 8 }}>
        The pre-fix run used the layer’s AVG view and was wrong; the official run abandoned the layer for SQL — and on many ACI tasks transcribed the same wrong recipe. The defect is the computational model the layer instills, not the language.
      </p>

      <Rule />

      {/* ── results explorer ── */}
      <Head kicker="interrogate it yourself" title="Per-question results explorer">Filter any run’s 419 answers by level, answer path, and correctness.</Head>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 12, fontFamily: SANS, fontSize: 12, alignItems: "center" }}>
        <label>run <select value={run} onChange={(e) => setFilter(setRun)(e.target.value)} style={sel}>{runOpts.map((o) => <option key={o} value={o}>{o}</option>)}</select></label>
        <label>level <select value={level} onChange={(e) => setFilter(setLevel)(e.target.value)} style={sel}><option value="all">all</option><option value="hard">hard</option><option value="easy">easy</option></select></label>
        <label>path <select value={path} onChange={(e) => setFilter(setPath)(e.target.value)} style={sel}><option value="all">all</option><option value="view">view-selection</option><option value="authored">authored</option><option value="sql">sql</option><option value="other">other</option></select></label>
        <label>result <select value={correct} onChange={(e) => setFilter(setCorrect)(e.target.value)} style={sel}><option value="all">all</option><option value="correct">correct</option><option value="incorrect">incorrect</option></select></label>
        <label><input type="checkbox" checked={onlyAF === "yes"} onChange={(e) => { setOnlyAF(e.target.checked ? "yes" : "no"); setPage(0); }} /> always-fail only</label>
      </div>
      {explorer.isLoading ? <Loading label="loading results…" /> : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: SANS, fontSize: 11, color: INK.muted, marginBottom: 4 }}>
            <span>{total} rows</span>
            <button disabled={cur <= 0} onClick={() => setPage(cur - 1)} style={pBtn(cur <= 0)}>‹ prev</button>
            <span>page {cur + 1} of {pages}</span>
            <button disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} style={pBtn(cur >= pages - 1)}>next ›</button>
          </div>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 560 }}>
            <thead><tr><th style={thL}>task</th><th style={thL}>level</th><th style={thL}>family</th><th style={thL}>path</th><th style={th}>✓</th><th style={thL}>predicted</th><th style={thL}>gold</th></tr></thead>
            <tbody>
              {ex.map((r, i) => (
                <tr key={i}>
                  <td style={{ ...tdL, fontFamily: MONO }}>{String(r.task_id)}</td>
                  <td style={tdL}>{String(r.level)}</td>
                  <td style={{ ...tdL, fontSize: 11, color: INK.muted }}>{r.family ? "ACI template" : "—"}</td>
                  <td style={{ ...tdL, color: pathColor(String(r.answer_path)), fontWeight: 600 }}>{String(r.answer_path)}</td>
                  <td style={{ ...td, color: r.is_correct ? ARM.baseline : PATH.sql, fontWeight: 700 }}>{r.is_correct ? "✓" : "✗"}</td>
                  <td style={{ ...tdL, fontFamily: MONO, fontSize: 11, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(r.predicted ?? "")}</td>
                  <td style={{ ...tdL, fontFamily: MONO, fontSize: 11, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(r.gold ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Rule />

      {/* ── overfit ── */}
      <Head kicker="is the layer overfit to train?" title="Train vs held-out">The layer was authored by reading the 26 train Q/A, so held-out is the honest test. It tracks train — the layer generalizes; it is simply less efficient.</Head>
      {overfit.isLoading ? <Loading label="loading…" /> : (
        <div style={{ display: "flex", gap: 30, fontFamily: SANS, flexWrap: "wrap" }}>
          {(["sonnet+opus", "gemini"] as const).map((tier) => {
            const tr = ofRow(tier, "train"); const te = ofRow(tier, "test");
            return (
              <div key={tier}>
                <div style={{ fontSize: 12, color: INK.muted, marginBottom: 4 }}>{tier} · committed layer</div>
                <div style={{ display: "flex", gap: 18 }}>
                  <div><div style={{ fontFamily: MONO, fontSize: 22, color: INK.text }}>{tr ? pct(tr.avg_acc) : "—"}</div><div style={{ fontSize: 11, color: INK.faint }}>train (avg, {tr ? N(tr.runs) : 0} runs)</div></div>
                  <div style={{ alignSelf: "center", color: INK.faint }}>→</div>
                  <div><div style={{ fontFamily: MONO, fontSize: 22, color: ARM.malloy }}>{te ? pct(te.avg_acc) : "—"}</div><div style={{ fontSize: 11, color: INK.faint }}>held-out</div></div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

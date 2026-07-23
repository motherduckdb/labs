import { useSQLQuery, useDiveState } from "@motherduck/react-sql-query";
import { N, rows, esc, STORY, INK, ARM, PATH, SERIF, SANS, MONO, Head, Loading, sel, OFFICIAL, PREFIX, CONTROLLED } from "./lib";

export default function TracesTab() {
  const runsQ = useSQLQuery(`SELECT run_id, run_label FROM "agentic_malloy_story"."main"."runs" WHERE arm='malloy' AND split='test' ORDER BY correct DESC`);
  const ex = useSQLQuery(`SELECT
      (SELECT task_id FROM "agentic_malloy_story"."main"."results" WHERE run_label='${OFFICIAL}' AND has_malloy AND is_correct ORDER BY TRY_CAST(task_id AS INT) LIMIT 1) AS clean_win,
      (SELECT task_id FROM "agentic_malloy_story"."main"."results" WHERE run_label='${CONTROLLED}' AND hit_limit ORDER BY TRY_CAST(task_id AS INT) LIMIT 1) AS thrash`);
  const exemplar = rows(ex.data)[0] || {};

  const [runLabel, setRunLabel] = useDiveState<string>("trace_run", OFFICIAL);
  const [task, setTask] = useDiveState<string>("trace_task", "1443");
  const rrun = rows(runsQ.data);
  const runId = rrun.find((r) => r.run_label === runLabel)?.run_id;

  const trace = useSQLQuery(
    `SELECT kind, tool, status, ms, arg, files, output, t
      FROM "agentic_malloy_story"."main"."trace_events"
      WHERE run_id='${esc(runId)}' AND task_id='${esc(task)}'
      ORDER BY ord`,
    { enabled: !!runId && !!task },
  );
  const verdict = useSQLQuery(
    `SELECT is_correct, answer_path, predicted, gold FROM "agentic_malloy_story"."main"."results" WHERE run_label='${esc(runLabel)}' AND task_id='${esc(task)}' LIMIT 1`,
    { enabled: !!task },
  );
  const tr = rows(trace.data);
  const v = rows(verdict.data)[0];

  const presets: [string, string, string][] = [
    ["AVG-view failure", PREFIX, "1443"],
    ["SQL off-ramp", OFFICIAL, "1443"],
    ["clean win", OFFICIAL, String(exemplar.clean_win ?? "1")],
    ["thrash / limit", CONTROLLED, String(exemplar.thrash ?? "1")],
  ];
  const isErr = (s: unknown) => String(s ?? "").toLowerCase().includes("err");

  return (
    <div>
      <Head kicker="what the agent actually did" title="Agent trace explorer">
        The live tool-by-tool trace from the controllog — explore → author → run → submit, with each tool’s result and errors.
      </Head>

      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 12 }}>
        {presets.map(([label, rl, tk]) => {
          const active = runLabel === rl && task === tk;
          return (
            <button key={label} onClick={() => { setRunLabel(rl); setTask(tk); }}
              style={{ fontFamily: SANS, fontSize: 11.5, padding: "5px 10px", borderRadius: 4, cursor: "pointer",
                border: `1px solid ${active ? ARM.malloy : INK.rule}`, background: active ? "#eaf1f7" : INK.paper,
                color: active ? ARM.malloy : INK.text, fontWeight: active ? 700 : 400 }}>{label}</button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 12, fontFamily: SANS, fontSize: 12, alignItems: "center" }}>
        <label>run <select value={runLabel} onChange={(e) => setRunLabel(e.target.value)} style={sel}>{rrun.map((r) => <option key={String(r.run_id)} value={String(r.run_label)}>{String(r.run_label)}</option>)}</select></label>
        <label>task <input value={task} onChange={(e) => setTask(e.target.value)} style={{ ...sel, fontFamily: MONO, width: 70 }} /></label>
        {v ? <span style={{ fontSize: 12, color: INK.muted }}>submitted as <b style={{ color: v.answer_path === "sql" ? PATH.sql : ARM.malloy }}>{String(v.answer_path)}</b> · predicted <b style={{ fontFamily: MONO }}>{String(v.predicted)}</b> vs gold <b style={{ fontFamily: MONO }}>{String(v.gold)}</b> <span style={{ color: v.is_correct ? ARM.baseline : PATH.sql, fontWeight: 700 }}>{v.is_correct ? "✓" : "✗"}</span></span> : null}
      </div>

      {trace.isLoading ? <Loading label="loading trace…" /> :
        tr.length === 0 ? <p style={{ fontFamily: SERIF, fontStyle: "italic", color: INK.muted }}>No trace events for this run / task.</p> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {tr.map((e, i) => {
              const think = e.kind === "model_completion";
              const call = e.kind === "tool_call";
              const err = e.kind === "tool_result" && isErr(e.status);
              const color = think ? INK.faint : call ? ARM.malloy : err ? PATH.sql : ARM.baseline;
              const label = think ? "think" : call ? `→ ${String(e.tool)}` : `${err ? "✗" : "✓"} ${String(e.tool ?? "result")}`;
              const arg = e.arg ? String(e.arg) : e.files ? `files: ${String(e.files)}` : "";
              const out = e.kind === "tool_result" && e.output ? String(e.output) : "";
              return (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", fontFamily: SANS }}>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: INK.faint, paddingTop: 3, minWidth: 56 }}>{String(e.t)}</span>
                  <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, color, minWidth: 116 }}>
                    {label}{e.ms ? <span style={{ color: INK.faint, fontWeight: 400 }}> {N(e.ms)}ms</span> : null}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {arg ? <pre style={{ margin: 0, fontFamily: MONO, fontSize: 10.5, color: INK.text, background: INK.paper, border: `1px solid ${INK.rule}`, borderRadius: 4, padding: "4px 8px", overflowX: "auto", whiteSpace: "pre-wrap", maxHeight: 110 }}>{arg.slice(0, 700)}</pre> : null}
                    {out ? <pre style={{ margin: arg ? "3px 0 0" : 0, fontFamily: MONO, fontSize: 10, color: err ? PATH.sql : INK.muted, background: INK.panel, borderRadius: 4, padding: "3px 8px", overflowX: "auto", whiteSpace: "pre-wrap", maxHeight: 80 }}>{out.slice(0, 400)}</pre> : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}

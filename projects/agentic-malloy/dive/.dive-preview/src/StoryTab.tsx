import { useSQLQuery, useDiveState } from "@motherduck/react-sql-query";
import { BarChart, Bar, XAxis, YAxis, ReferenceLine, LabelList, ResponsiveContainer } from "recharts";
import { N, rows, pct, STORY, INK, ARM, PATH, SERIF, SANS, MONO, Lede, Figure, Stat, OFFICIAL, PREFIX } from "./lib";

const APATH = { view: "#0a6aa8", authored: "#7ba6c4", sql: "#b0521f", other: "#cfcabb" };

function Chapter({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 9 }}>
        <span style={{ fontFamily: MONO, fontSize: 13, color: INK.faint }}>{String(n).padStart(2, "0")}</span>
        <h2 style={{ fontFamily: SERIF, fontSize: 25, fontWeight: 600, color: INK.text, margin: 0, letterSpacing: "-0.01em" }}>{title}</h2>
      </div>
      <div style={{ fontFamily: SERIF, fontSize: 15, color: INK.text, lineHeight: 1.6 }}>{children}</div>
    </section>
  );
}
const RUN_KEY = [
  ["official", "the canonical config behind the claim"],
  ["pre-fix", "before the skill fixes (raised it 88.3→91.2%)"],
  ["new-harness", "view-catalog + SQL fallback + linting"],
  ["controlled", "same-model baseline comparison"],
];

export default function StoryTab() {
  const [, setTab] = useDiveState<string>("tab", "story");
  const [, setAci] = useDiveState<string>("aci_task", "1443");
  const [, setTraceRun] = useDiveState<string>("trace_run", OFFICIAL);
  const [, setTraceTask] = useDiveState<string>("trace_task", "1443");
  const go = (tab: string, fn?: () => void) => () => { if (fn) fn(); setTab(tab); };
  const Link = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) => (
    <button onClick={onClick} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: ARM.malloy, fontFamily: SANS, fontSize: 13, fontWeight: 600, borderBottom: `1px solid ${ARM.malloy}55` }}>{children} →</button>
  );

  const runsQ = useSQLQuery(`SELECT run_label, arm, acc_pct, median_prompt_tokens AS tok, pct_sql, controlled_pair FROM "agentic_malloy_story"."main"."runs" WHERE split='test' ORDER BY acc_pct DESC`);
  const aciQ = useSQLQuery(`SELECT r.run_label, count(*) AS n, sum(r.is_correct::int) AS correct
    FROM "agentic_malloy_story"."main"."results" r JOIN "agentic_malloy_story"."main"."tasks" t USING (task_id)
    WHERE t.family='aci_most_expensive_template' AND r.run_label IN ('Baseline · markdown+SQL (gemini)','${OFFICIAL}','${PREFIX}') GROUP BY r.run_label`);
  const pathQ = useSQLQuery(`SELECT answer_path, count(*) AS n FROM "agentic_malloy_story"."main"."results" WHERE run_label='${OFFICIAL}' GROUP BY answer_path`);

  const rr = rows(runsQ.data);
  const baseline = rr.find((r) => r.arm === "baseline");
  const malloy = rr.filter((r) => r.arm === "malloy");
  const best = malloy[0];
  const ctrlB = rr.find((r) => r.controlled_pair && r.arm === "baseline");
  const ctrlM = rr.find((r) => r.controlled_pair && r.arm === "malloy");
  const tokMult = ctrlB && ctrlM ? N(ctrlM.tok) / N(ctrlB.tok) : 0;
  const officialSql = best ? N(best.pct_sql) : 0;
  const chart = malloy.map((r) => ({ label: String(r.run_label).replace("Malloy · ", ""), acc: N(r.acc_pct) }));
  const aci = rows(aciQ.data);
  const aBase = aci.find((r) => String(r.run_label).includes("Baseline"));
  const aView = aci.find((r) => String(r.run_label).includes("pre-fix"));
  const aSql = aci.find((r) => String(r.run_label).endsWith("official"));
  const pr = rows(pathQ.data); const pN = (k: string) => N(pr.find((r) => r.answer_path === k)?.n);
  const pTot = pr.reduce((s, r) => s + N(r.n), 0) || 1;

  return (
    <div>
      <Chapter n={1} title="The thesis">
        <Lede>A semantic layer is supposed to be the clean way to hand an analytics agent its definitions —
          one source of truth per metric, governed and queryable. I wanted to know whether that actually
          helps the agent, or just feels tidy to us.</Lede>
        <p>So I ran the experiment: a <b>Malloy semantic layer</b> head-to-head against a tuned
          <b> markdown + SQL context layer</b> on <b>DABstep</b> — 26 training questions, 419 held out. The bar
          is a conjunction — the layer has to win on tokens <i>and</i> not lose accuracy. Same model, same
          scorer, same data. The only thing that changes is the substrate the agent reads from.</p>
      </Chapter>

      <Chapter n={2} title="What I tested">
        <p>Both arms explore the data with SQL on MotherDuck. The difference is the final answer: the baseline
          submits SQL, the Malloy arm submits compiled Malloy. That’s the only knob I turned.</p>
        <div style={{ display: "flex", gap: 14, margin: "12px 0", flexWrap: "wrap" }}>
          {[["Baseline", ARM.baseline, "Markdown context items + SQL patterns the agent adapts per question."],
            ["Treatment", ARM.malloy, "A model-authored Malloy layer: one source per entity, joins, views."]].map(([t, c, d]) => (
            <div key={t as string} style={{ flex: "1 1 240px", borderTop: `2px solid ${c as string}`, paddingTop: 8 }}>
              <div style={{ fontFamily: SANS, fontWeight: 700, color: c as string, fontSize: 13 }}>{t}</div>
              <div style={{ fontFamily: SERIF, fontSize: 13.5, color: INK.muted, marginTop: 3, lineHeight: 1.5 }}>{d}</div>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 13.5, color: INK.muted }}><b style={{ color: INK.text }}>A model wrote the layer, not me</b> —
          it read the manual, the 26 Q/A, and the schema, authored the Malloy, cleared a compile-and-execute gate and a
          repair loop, then had its provenance locked. So before you ask: I didn’t hand-tune Malloy to lose. This is not
          a “bad Malloy” story. <Link onClick={go("build")}>how the layer was built</Link></p>
      </Chapter>

      <Chapter n={3} title="The result">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 22, margin: "2px 0 18px" }}>
          <Stat value={baseline ? pct(baseline.acc_pct) : "—"} label="Baseline accuracy" color={ARM.baseline} sub="markdown + SQL" />
          <Stat value={best ? pct(best.acc_pct) : "—"} label="Best Malloy accuracy" color={ARM.malloy} sub="never reaches baseline" />
          <Stat value={tokMult ? `${tokMult.toFixed(1)}×` : "—"} label="Prompt tokens, same model" color={PATH.sql} sub="the substrate tax" />
        </div>
        <Figure caption={<>Each Malloy run against the baseline (dashed) — <b>none reach it</b>. At a fixed model, the substrate alone costs {tokMult ? `${tokMult.toFixed(1)}×` : ""} the prompt tokens. <Link onClick={go("metrics")}>the full matrix</Link></>}>
          {runsQ.isLoading ? <div className="animate-pulse" style={{ height: 210, background: "#eceae3", borderRadius: 3 }} /> : (
            <>
              <ResponsiveContainer width="100%" height={210}>
                <BarChart data={chart} layout="vertical" margin={{ left: 8, right: 52, top: 14, bottom: 4 }}>
                  <XAxis type="number" domain={[0, 100]} hide />
                  <YAxis type="category" dataKey="label" width={188} tick={{ fontSize: 11, fill: INK.muted, fontFamily: SANS }} axisLine={false} tickLine={false} />
                  <ReferenceLine x={N(baseline?.acc_pct) || 99.8} stroke={ARM.baseline} strokeDasharray="4 3" label={{ value: `baseline ${baseline ? pct(baseline.acc_pct) : ""}`, position: "top", fontSize: 10.5, fill: ARM.baseline, fontFamily: SANS }} />
                  <Bar dataKey="acc" fill={ARM.malloy} radius={[0, 2, 2, 0]} barSize={14}>
                    <LabelList dataKey="acc" position="right" formatter={(v: number) => `${v}%`} style={{ fontFamily: MONO, fontSize: 11, fill: INK.text }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div style={{ fontFamily: SANS, fontSize: 11, color: INK.faint, marginTop: 4, lineHeight: 1.6 }}>
                {RUN_KEY.map(([t, d], i) => <span key={t} style={{ marginRight: 12 }}><b style={{ color: INK.muted }}>{t}</b> {d}</span>)}
              </div>
            </>
          )}
        </Figure>
      </Chapter>

      <Chapter n={4} title="Three findings">
        <ol style={{ paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 15, margin: 0 }}>
          <li>
            <b style={{ fontFamily: SANS, fontSize: 13 }}>1 · The token tax is structural.</b>
            <p style={{ margin: "3px 0 0" }}>More layer, more per-query Malloy, a view catalog to read — <b>{tokMult ? `${tokMult.toFixed(1)}×` : "~2.5×"}</b> the
              prompt tokens at a fixed model, no accuracy gained. <Link onClick={go("metrics")}>compare runs</Link></p>
          </li>
          <li>
            <b style={{ fontFamily: SANS, fontSize: 13 }}>2 · The layer is mostly bypassed.</b>
            <p style={{ margin: "3px 0 0" }}>The best run answered <b style={{ color: PATH.sql }}>{officialSql.toFixed(0)}% of questions in raw SQL</b>, not
              Malloy, and touched only <b>12 of 83</b> views. Fixing the layer’s defect changed nothing — it wasn’t doing the work. <Link onClick={go("layer")}>view utilization</Link></p>
          </li>
          <li>
            <b style={{ fontFamily: SANS, fontSize: 13 }}>3 · A compiled view freezes one interpretation; prose adapts.</b>
            <p style={{ margin: "3px 0 0" }}>When a question fits a pre-built view, Malloy matches the baseline. When it doesn’t, the view applies
              <b> one frozen interpretation</b> — and the wrong logic persists even after the agent bails to SQL. Documented patterns can be
              re-read and adapted per question; a compiled view can’t. <span style={{ color: INK.muted }}>(Example — a fee-ranking question the layer
              answered by <i>averaging</i> where the answer is a <i>sum</i>: baseline
              {aBase ? <b style={{ color: ARM.baseline }}> {N(aBase.correct)}/{N(aBase.n)}</b> : " —"}, the view
              {aView ? <b style={{ color: PATH.sql }}> {N(aView.correct)}/{N(aView.n)}</b> : " —"}, the SQL bail
              {aSql ? <b> {N(aSql.correct)}/{N(aSql.n)}</b> : " —"}.)</span>{" "}
              <Link onClick={go("metrics", () => setAci("1443"))}>see it</Link> · <Link onClick={go("traces", () => { setTraceRun(PREFIX); setTraceTask("1443"); })}>trace it</Link></p>
          </li>
        </ol>
      </Chapter>

      <Chapter n={5} title="The verdict">
        <p>Used as the agent’s primary answering substrate, Malloy was slower, heavier, and less accurate than
          context + SQL. When the path was obvious it could match the baseline — at a token and latency premium.
          When it wasn’t, the executable view froze the wrong interpretation while prose just adapted.</p>
        <p style={{ marginTop: 10 }}>Here’s the part I didn’t expect: <b>models write passable Malloy</b> — it compiles, runs, and
          generalizes. Models readily synthesize SQL but struggle to make Malloy <i>dance</i>; the dominant failure here isn’t
          authoring, it’s using the layer as the thinking medium. <Link onClick={go("build")}>how the layer was built</Link></p>
        <div style={{ marginTop: 12, padding: "10px 14px", borderLeft: `3px solid ${INK.faint}`, background: INK.panel }}>
          <span style={{ fontFamily: SANS, fontSize: 12.5, color: INK.text }}>
            <b>Scope.</b> One benchmark, one harness, one layer build — this is about Malloy <i>as an LLM substrate</i>. It
            says nothing about a semantic layer as a deterministic interface for non-agent systems, which I didn’t test.</span>
        </div>
      </Chapter>

      <Chapter n={6} title="What I’d build next">
        <p>The layer’s value isn’t helping the model reason — it’s making chosen definitions <b>executable,
          governed, testable, and reusable outside the LLM loop</b>: provenance, permissions, lineage, metric
          contracts, regression tests, interoperability with non-agent tools. The shape:</p>
        <ul style={{ paddingLeft: 18, margin: "8px 0", display: "flex", flexDirection: "column", gap: 5 }}>
          <li><b>Context is the authoring and reasoning substrate</b>; SQL is the execution language.</li>
          <li><b>Semantic-layer objects are promoted artifacts</b>, not the default medium — promotion requires tests, so a bad interpretation can’t freeze.</li>
          <li><b>Force a governed lookup first, with clear off-ramps</b> — if it doesn’t fit, use the layer as <i>context</i> for a SQL answer, and log a promotion candidate. <span style={{ color: INK.muted }}>(My stance; force-first vs. optional is still open.)</span></li>
        </ul>
        <Figure caption={<>The strongest proxy — the {best ? pct(best.acc_pct) : ""} hybrid. Governed lookup (<b style={{ color: APATH.view }}>view-selection</b>) carried only {pN("view")} of {pTot}; the agent <b style={{ color: APATH.sql }}>off-ramped to SQL</b> for {pN("sql")}. The off-ramp helped — the lookup couldn’t carry most questions. <b>Enough to validate the direction, not the protocol.</b></>}>
          {pathQ.isLoading ? <div className="animate-pulse" style={{ height: 38, background: "#eceae3", borderRadius: 3 }} /> : (
            <div>
              <div style={{ display: "flex", height: 30, borderRadius: 3, overflow: "hidden", border: `1px solid ${INK.rule}` }}>
                {(["view", "authored", "sql", "other"] as const).map((k) => {
                  const n = pN(k); if (!n) return null;
                  return <div key={k} title={`${k}: ${n}`} style={{ width: `${(n / pTot) * 100}%`, background: APATH[k], display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: k === "authored" ? INK.text : "#fff" }}>{n}</span></div>;
                })}
              </div>
              <div style={{ display: "flex", gap: 14, marginTop: 6, fontFamily: SANS, fontSize: 11.5, color: INK.muted }}>
                <span><span style={{ color: APATH.view }}>■</span> view-selection</span>
                <span><span style={{ color: APATH.authored }}>■</span> authored Malloy</span>
                <span><span style={{ color: APATH.sql }}>■</span> SQL off-ramp</span>
              </div>
            </div>
          )}
        </Figure>
        <p style={{ fontSize: 13.5, color: INK.muted, fontStyle: "italic" }}>The next test isn’t a benchmark — a repeated,
          multi-consumer workload with a hard protocol (lookup → judge fit → off-ramp → promote), where governance and the promotion flywheel are observable.</p>
      </Chapter>
    </div>
  );
}

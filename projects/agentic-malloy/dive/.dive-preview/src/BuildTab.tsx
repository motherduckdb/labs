import { useSQLQuery, useDiveState } from "@motherduck/react-sql-query";
import { N, rows, STORY, INK, ARM, PATH, SERIF, SANS, MONO, Head, Figure, Loading, Rule, sel } from "./lib";

export default function BuildTab() {
  const surf = useSQLQuery(`SELECT
      (SELECT length(content) FROM "agentic_malloy_story"."main"."documents" WHERE kind='skill') AS malloy_skill,
      (SELECT coalesce(sum(length(content)),0) FROM "agentic_malloy_story"."main"."documents" WHERE kind='layer') AS malloy_layer,
      (SELECT count(*) FROM "agentic_malloy_story"."main"."documents" WHERE kind='layer') AS malloy_layer_n,
      (SELECT coalesce(length(content),0) FROM "agentic_malloy_story"."main"."documents" WHERE kind='provenance') AS malloy_meta,
      (SELECT length(content) FROM "agentic_malloy_story"."main"."documents" WHERE kind='baseline_skill') AS base_skill,
      (SELECT count(*) FROM "agentic_malloy_story"."main"."documents" WHERE kind='baseline_context') AS base_ctx_n,
      (SELECT sum(length(content)) FROM "agentic_malloy_story"."main"."documents" WHERE kind='baseline_context') AS base_ctx_chars`);
  const ctxList = useSQLQuery(`SELECT title, length(content) AS chars FROM "agentic_malloy_story"."main"."documents" WHERE kind='baseline_context' ORDER BY title`);
  const layerList = useSQLQuery(`SELECT title, length(content) AS chars FROM "agentic_malloy_story"."main"."documents" WHERE kind='layer' ORDER BY title`);

  const [doc, setDoc] = useDiveState<string>("build_doc", "malloy_skill");
  const docQ = useSQLQuery(
    doc === "malloy_skill" ? `SELECT content FROM "agentic_malloy_story"."main"."documents" WHERE kind='skill' LIMIT 1`
    : doc === "baseline_skill" ? `SELECT content FROM "agentic_malloy_story"."main"."documents" WHERE kind='baseline_skill' LIMIT 1`
    : doc === "provenance" ? `SELECT content FROM "agentic_malloy_story"."main"."documents" WHERE kind='provenance' LIMIT 1`
    : doc.startsWith("layer::") ? `SELECT content FROM "agentic_malloy_story"."main"."documents" WHERE kind='layer' AND title='${doc.slice(7).replace(/'/g, "''")}' LIMIT 1`
    : `SELECT content FROM "agentic_malloy_story"."main"."documents" WHERE kind='baseline_context' AND title='${doc.replace(/'/g, "''")}' LIMIT 1`,
  );

  const provQ = useSQLQuery(`SELECT content FROM "agentic_malloy_story"."main"."documents" WHERE kind='provenance' LIMIT 1`);
  const layerFiles = useSQLQuery(`SELECT count(*) AS n, sum(length(content)) AS chars FROM "agentic_malloy_story"."main"."documents" WHERE kind='layer'`);
  let prov: any = {};
  try { prov = JSON.parse(String(rows(provQ.data)[0]?.content ?? "{}")); } catch { prov = {}; }
  const lf = rows(layerFiles.data)[0] || {};

  const s = rows(surf.data)[0] || {};
  // Fair comparison: each arm = answer-time SKILL + its broader knowledge surface
  // (retrievable context items for the baseline; the model-authored Malloy layer + provenance metadata for Malloy).
  const mSkill = N(s.malloy_skill), mLayer = N(s.malloy_layer), mMeta = N(s.malloy_meta);
  const malloyTotal = mSkill + mLayer + mMeta;
  const bSkill = N(s.base_skill), bCtx = N(s.base_ctx_chars);
  const baseTotal = bSkill + bCtx;
  const maxTotal = Math.max(malloyTotal, baseTotal) || 1;
  const mult = baseTotal ? malloyTotal / baseTotal : 0;   // Malloy surface vs baseline surface
  const surfaceBars = [
    { arm: "Malloy arm", color: ARM.malloy, total: malloyTotal, files: 1 + N(s.malloy_layer_n) + (mMeta ? 1 : 0),
      segs: [{ label: "skill.md", chars: mSkill },
             { label: `semantic layer + metadata (${N(s.malloy_layer_n)} .malloy)`, chars: mLayer + mMeta }] },
    { arm: "Baseline", color: ARM.baseline, total: baseTotal, files: 1 + N(s.base_ctx_n),
      segs: [{ label: "SKILL.md", chars: bSkill },
             { label: `${N(s.base_ctx_n)} context items`, chars: bCtx }] },
  ];
  const flow = ["explore (MCP SQL)", "list_views / get_file", "author Malloy", "run_malloy → compile → exec", "submit (Malloy or SQL)"];
  const buildFlow = ["read manual + 26 train Q/A + schema", "author the layer (source-per-entity → joins → views)", "compile + execute every view (P0 gate)", "repair loop on failures", "hash + lock provenance"];

  return (
    <div>
      <Head kicker="this is not a “bad Malloy” story" title="The layer was authored by a model, not a human">
        A procedure builds it: an expensive model reads the manual, the 26 train Q/A, and the schema, then writes the
        whole layer — compile-and-execute-gated, with a repair loop, then provenance-locked. Humans only tune the build
        prompt; the layer files are never hand-edited. The result is accurate Malloy that generalizes — the problem is using it.
      </Head>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center", marginBottom: 12 }}>
        {buildFlow.map((s2, i) => (
          <div key={s2} style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontFamily: SANS, fontSize: 11.5, padding: "4px 9px", border: `1px solid ${INK.rule}`, borderRadius: 4, background: INK.paper, color: INK.text }}>{s2}</span>
            {i < buildFlow.length - 1 ? <span style={{ color: INK.faint }}>→</span> : null}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 26, flexWrap: "wrap", fontFamily: SANS, fontSize: 12, marginBottom: 6 }}>
        {[["provenance", String(prov.malloy_provenance ?? "—")],
          ["authoring model", String(prov.authoring_model ?? "—").replace("anthropic/", "")],
          ["manual included", prov.manual_included ? "yes" : "no"],
          ["improve rounds", String(prov.improve_round ?? 0)],
          ["model hash", String(prov.malloy_model_hash ?? "—")],
          ["layer size", `${N(lf.n)} files · ${N(lf.chars).toLocaleString()} ch`]].map(([k, v]) => (
          <div key={k as string}><div style={{ color: INK.faint, fontSize: 11 }}>{k as string}</div><div style={{ fontFamily: MONO, color: INK.text }}>{v as string}</div></div>
        ))}
      </div>
      <p style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 12.5, color: INK.muted }}>
        An <b>official</b> run fails fast unless the on-disk layer still hashes to the recorded value — a hand-edit
        breaks the hash and disqualifies the run. So the 91.2% is genuinely model-authored Malloy.
      </p>

      <Rule />

      <Head kicker="how the agent was set up" title="The harness">A two-model author→fixer loop explores via MotherDuck MCP, authors Malloy, compiles it to SQL (a deterministic translation-check), and submits. On repeated compile errors it steers in place rather than escalating to the bigger model.</Head>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center", marginBottom: 8 }}>
        {flow.map((s2, i) => (
          <div key={s2} style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontFamily: SANS, fontSize: 11.5, padding: "4px 9px", border: `1px solid ${INK.rule}`, borderRadius: 4, background: INK.paper, color: INK.text }}>{s2}</span>
            {i < flow.length - 1 ? <span style={{ color: INK.faint }}>→</span> : null}
          </div>
        ))}
      </div>
      <p style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 12.5, color: INK.muted }}>The Malloy answer compiles to SQL, so the Malloy→SQL translation is checkable; the layer is model-authored (provenance-gated, never hand-edited).</p>

      <Rule />

      <Head kicker="is the comparison fair?" title="The tuning asymmetry">Neither arm is “just” its answer-time skill. The baseline pairs SKILL.md with retrievable context items; the Malloy arm pairs skill.md with a model-authored semantic layer. Counted fairly — skill <b>plus</b> surface — the Malloy arm is the <b>larger</b>, more-tuned surface. So the gap isn’t “less context to work with.”</Head>
      <Figure caption={<>Total knowledge surface, in characters — each arm’s answer-time <b>skill</b> (darker) stacked with its broader <b>surface</b> (lighter): {N(s.base_ctx_n)} retrievable context items for the baseline, the model-authored semantic layer + provenance metadata for Malloy. Counted this way the Malloy arm is {mult ? `${mult.toFixed(1)}×` : ""} the baseline’s surface — so the easy-question gap isn’t a resourcing gap. The layer is there; it just goes largely unused (next section).</>}>
        {surf.isLoading ? <Loading label="measuring…" /> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 560 }}>
            {surfaceBars.map((b) => (
              <div key={b.arm}>
                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: SANS, fontSize: 12, marginBottom: 3 }}>
                  <span style={{ color: b.color, fontWeight: 600 }}>{b.arm}</span>
                  <span style={{ fontFamily: MONO, color: INK.muted }}>{N(b.total).toLocaleString()} ch · {b.files} files</span>
                </div>
                <div style={{ display: "flex", height: 18, width: `${(b.total / maxTotal) * 100}%`, minWidth: 3, borderRadius: 2, overflow: "hidden" }}>
                  {b.segs.map((seg, i) => (
                    <div key={seg.label} title={`${seg.label} — ${N(seg.chars).toLocaleString()} ch`}
                      style={{ width: `${b.total ? (seg.chars / b.total) * 100 : 0}%`, background: b.color, opacity: i === 0 ? 0.95 : 0.4 }} />
                  ))}
                </div>
                <div style={{ display: "flex", gap: 12, marginTop: 4, fontFamily: SANS, fontSize: 10.5, color: INK.faint, flexWrap: "wrap" }}>
                  {b.segs.map((seg, i) => (
                    <span key={seg.label} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 1, background: b.color, opacity: i === 0 ? 0.95 : 0.4 }} />
                      {seg.label} · {N(seg.chars).toLocaleString()} ch
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Figure>

      <Head title="Read the prompts">&nbsp;</Head>
      <div style={{ marginBottom: 10, fontFamily: SANS, fontSize: 12 }}>
        <select value={doc} onChange={(e) => setDoc(e.target.value)} style={sel}>
          <option value="malloy_skill">Malloy arm — skill.md</option>
          <optgroup label="Malloy semantic layer (.malloy models)">
            {rows(layerList.data).map((c) => <option key={`layer::${c.title}`} value={`layer::${c.title}`}>{String(c.title)} ({N(c.chars)} ch)</option>)}
          </optgroup>
          <optgroup label="Malloy metadata">
            <option value="provenance">.provenance.json ({N(mMeta)} ch)</option>
          </optgroup>
          <option value="baseline_skill">Baseline — SKILL.md</option>
          <optgroup label="Baseline context items">
            {rows(ctxList.data).map((c) => <option key={String(c.title)} value={String(c.title)}>{String(c.title)} ({N(c.chars)} ch)</option>)}
          </optgroup>
        </select>
      </div>
      {docQ.isLoading ? <Loading label="loading…" /> : (
        <pre style={{ margin: 0, padding: 13, fontFamily: MONO, fontSize: 11, color: INK.text, background: INK.paper, border: `1px solid ${INK.rule}`, borderRadius: 4, overflow: "auto", maxHeight: 440, whiteSpace: "pre-wrap" }}>
          {String(rows(docQ.data)[0]?.content ?? "")}
        </pre>
      )}
    </div>
  );
}

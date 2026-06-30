import { useSQLQuery, useDiveState } from "@motherduck/react-sql-query";
import { N, rows, STORY, INK, ARM, PATH, SERIF, SANS, MONO, Head, Figure, Loading, Rule, sel } from "./lib";

export default function BuildTab() {
  const surf = useSQLQuery(`SELECT
      (SELECT length(content) FROM "agentic_malloy_story"."main"."documents" WHERE kind='skill') AS malloy_skill,
      (SELECT coalesce(length(content),0) FROM "agentic_malloy_story"."main"."documents" WHERE kind='primer') AS malloy_primer,
      (SELECT coalesce(length(content),0) FROM "agentic_malloy_story"."main"."documents" WHERE kind='glossary') AS malloy_glossary,
      (SELECT coalesce(sum(length(content)),0) FROM "agentic_malloy_story"."main"."documents" WHERE kind='layer') AS malloy_layer,
      (SELECT count(*) FROM "agentic_malloy_story"."main"."documents" WHERE kind='layer') AS malloy_layer_n,
      (SELECT coalesce(sum(length(content)),0) FROM "agentic_malloy_story"."main"."documents" WHERE kind='layer_meta') AS malloy_meta,
      (SELECT count(*) FROM "agentic_malloy_story"."main"."documents" WHERE kind='layer_meta') AS malloy_meta_n,
      (SELECT length(content) FROM "agentic_malloy_story"."main"."documents" WHERE kind='baseline_skill') AS base_skill,
      (SELECT count(*) FROM "agentic_malloy_story"."main"."documents" WHERE kind='baseline_context') AS base_ctx_n,
      (SELECT sum(length(content)) FROM "agentic_malloy_story"."main"."documents" WHERE kind='baseline_context') AS base_ctx_chars`);
  const ctxList = useSQLQuery(`SELECT title, length(content) AS chars FROM "agentic_malloy_story"."main"."documents" WHERE kind='baseline_context' ORDER BY title`);
  const layerList = useSQLQuery(`SELECT title, length(content) AS chars FROM "agentic_malloy_story"."main"."documents" WHERE kind='layer' ORDER BY title`);
  const metaList = useSQLQuery(`SELECT title, length(content) AS chars FROM "agentic_malloy_story"."main"."documents" WHERE kind='layer_meta' ORDER BY title`);

  const [doc, setDoc] = useDiveState<string>("build_doc", "malloy_skill");
  const docQ = useSQLQuery(
    doc === "malloy_skill" ? `SELECT content FROM "agentic_malloy_story"."main"."documents" WHERE kind='skill' LIMIT 1`
    : doc === "primer" ? `SELECT content FROM "agentic_malloy_story"."main"."documents" WHERE kind='primer' LIMIT 1`
    : doc === "glossary" ? `SELECT content FROM "agentic_malloy_story"."main"."documents" WHERE kind='glossary' LIMIT 1`
    : doc === "baseline_skill" ? `SELECT content FROM "agentic_malloy_story"."main"."documents" WHERE kind='baseline_skill' LIMIT 1`
    : doc.startsWith("layer::") ? `SELECT content FROM "agentic_malloy_story"."main"."documents" WHERE kind='layer' AND title='${doc.slice(7).replace(/'/g, "''")}' LIMIT 1`
    : doc.startsWith("meta::") ? `SELECT content FROM "agentic_malloy_story"."main"."documents" WHERE kind='layer_meta' AND title='${doc.slice(6).replace(/'/g, "''")}' LIMIT 1`
    : `SELECT content FROM "agentic_malloy_story"."main"."documents" WHERE kind='baseline_context' AND title='${doc.replace(/'/g, "''")}' LIMIT 1`,
  );

  const provQ = useSQLQuery(`SELECT content FROM "agentic_malloy_story"."main"."documents" WHERE kind='provenance' LIMIT 1`);
  const layerFiles = useSQLQuery(`SELECT count(*) AS n, sum(length(content)) AS chars FROM "agentic_malloy_story"."main"."documents" WHERE kind='layer'`);
  let prov: any = {};
  try { prov = JSON.parse(String(rows(provQ.data)[0]?.content ?? "{}")); } catch { prov = {}; }
  const lf = rows(layerFiles.data)[0] || {};

  const s = rows(surf.data)[0] || {};
  // Fair comparison by WORKFLOW: each arm = what it INJECTS into every prompt +
  // the deeper surface it RETRIEVES on demand. Itemized to every curated artifact.
  //   Malloy injected: skill.md + Malloy primer + glossary (cli.ts system prompt)
  //   Malloy retrieved: .malloy models + _meta sidecars (list_views / get_file)
  //   Baseline injected: SKILL.md ; retrieved: context items (semantic_lookup)
  const mSkill = N(s.malloy_skill), mPrimer = N(s.malloy_primer), mGloss = N(s.malloy_glossary);
  const mLayer = N(s.malloy_layer), mMeta = N(s.malloy_meta);
  const malloyTotal = mSkill + mPrimer + mGloss + mLayer + mMeta;
  const bSkill = N(s.base_skill), bCtx = N(s.base_ctx_chars);
  const baseTotal = bSkill + bCtx;
  const maxTotal = Math.max(malloyTotal, baseTotal) || 1;
  const mult = baseTotal ? malloyTotal / baseTotal : 0;   // Malloy surface vs baseline surface
  // Malloy blues (injected → darker, retrieved → lighter); baseline greens.
  const surfaceBars = [
    { arm: "Malloy arm", labelColor: ARM.malloy, total: malloyTotal,
      files: 1 + 1 + 1 + N(s.malloy_layer_n) + N(s.malloy_meta_n),
      segs: [
        { label: "skill.md", chars: mSkill, role: "injected", color: "#0a6aa8" },
        { label: "Malloy primer", chars: mPrimer, role: "injected", color: "#2f86c2" },
        { label: "domain glossary (YAML)", chars: mGloss, role: "injected", color: "#5aa0d0" },
        { label: `${N(s.malloy_layer_n)} .malloy models`, chars: mLayer, role: "retrieved", color: "#a9cce6" },
        { label: `${N(s.malloy_meta_n)} _meta sidecars (YAML)`, chars: mMeta, role: "retrieved", color: "#cfe3f2" },
      ] },
    { arm: "Baseline", labelColor: ARM.baseline, total: baseTotal, files: 1 + N(s.base_ctx_n),
      segs: [
        { label: "SKILL.md", chars: bSkill, role: "injected", color: "#2d6a2d" },
        { label: `${N(s.base_ctx_n)} context items`, chars: bCtx, role: "retrieved", color: "#9cc49c" },
      ] },
  ];
  const flow = ["explore (MCP SQL)", "list_views / get_file", "author Malloy", "run_malloy → compile → exec", "submit (Malloy or SQL)"];
  const buildFlow = ["read manual + 26 train Q/A + schema", "author the layer (source-per-entity → joins → views)", "compile + execute every view (P0 gate)", "repair loop on failures", "hash + lock provenance"];

  return (
    <div>
      <Head kicker="this is not a “bad Malloy” story" title="The layer was authored by a model, not a human">
        A procedure builds it: an expensive model reads the manual, the 26 train Q/A, and the schema, then writes the
        whole layer — compile-and-execute-gated, with a repair loop, then provenance-locked. I only tune the build
        prompt; I never hand-edit the layer files. The result is accurate Malloy that generalizes — the problem is using it.
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

      <Head kicker="is the comparison fair?" title="The tuning asymmetry">Neither arm is “just” its answer-time skill. Each one <b>injects</b> a skill into every prompt and <b>browses</b> a deeper surface on demand. Itemized fairly — every curated artifact each arm carries — the Malloy arm is {mult ? `${mult.toFixed(1)}×` : ""} the baseline’s surface. So the gap isn’t “less context to work with.”</Head>
      <Figure caption={<>Every curated artifact in each arm’s surface, in characters. <b>Injected</b> into every prompt (left of the divider): the baseline’s SKILL.md; the Malloy arm’s skill.md + Malloy primer + domain glossary. <b>Browsed on demand</b> (right): the baseline’s {N(s.base_ctx_n)} context items via <i>semantic_lookup</i>; the Malloy arm’s {N(s.malloy_layer_n)} .malloy models + {N(s.malloy_meta_n)} _meta sidecars via <i>list_views</i>/<i>get_file</i> — the navigation path into the models. The Malloy arm is {mult ? `${mult.toFixed(1)}×` : ""} the baseline’s surface; the easy-question gap isn’t a resourcing gap. (These are authored-artifact sizes — only part of each enters a given prompt: e.g. the {N(s.malloy_glossary).toLocaleString()}-ch glossary renders to ~8.6K. Under-use is the next section’s point.)</>}>
        {surf.isLoading ? <Loading label="measuring…" /> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 620 }}>
            {surfaceBars.map((b) => (
              <div key={b.arm}>
                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: SANS, fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: b.labelColor, fontWeight: 600 }}>{b.arm}</span>
                  <span style={{ fontFamily: MONO, color: INK.muted }}>{N(b.total).toLocaleString()} ch · {b.files} files</span>
                </div>
                <div style={{ display: "flex", height: 20, width: `${(b.total / maxTotal) * 100}%`, minWidth: 3, borderRadius: 2, overflow: "hidden", border: `1px solid ${INK.rule}` }}>
                  {b.segs.map((seg, i) => {
                    const boundary = i > 0 && seg.role === "retrieved" && b.segs[i - 1].role === "injected";
                    return (
                      <div key={seg.label} title={`${seg.label} — ${N(seg.chars).toLocaleString()} ch · ${seg.role}`}
                        style={{ width: `${b.total ? (seg.chars / b.total) * 100 : 0}%`, background: seg.color,
                          boxShadow: "inset -1px 0 0 rgba(255,255,255,0.7)", borderLeft: boundary ? `2px solid ${INK.text}` : "none" }} />
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: 20, marginTop: 6, flexWrap: "wrap" }}>
                  {(["injected", "retrieved"] as const).map((role) => {
                    const segs = b.segs.filter((x) => x.role === role);
                    if (!segs.length) return null;
                    return (
                      <div key={role} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <span style={{ fontFamily: SANS, fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color: INK.faint }}>
                          {role === "injected" ? "injected every prompt" : "browsed on demand"}
                        </span>
                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                          {segs.map((seg) => (
                            <span key={seg.label} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: SANS, fontSize: 10.5, color: INK.muted }}>
                              <span style={{ width: 9, height: 9, borderRadius: 1, background: seg.color, border: `1px solid ${INK.rule}` }} />
                              {seg.label} <span style={{ fontFamily: MONO, color: INK.faint }}>{N(seg.chars).toLocaleString()}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Figure>

      <Head title="Read the prompts">&nbsp;</Head>
      <div style={{ marginBottom: 10, fontFamily: SANS, fontSize: 12 }}>
        <select value={doc} onChange={(e) => setDoc(e.target.value)} style={sel}>
          <optgroup label="Malloy — injected every prompt">
            <option value="malloy_skill">skill.md ({N(mSkill)} ch)</option>
            <option value="primer">malloy-primer.md ({N(mPrimer)} ch)</option>
            <option value="glossary">_glossary.yaml ({N(mGloss)} ch)</option>
          </optgroup>
          <optgroup label="Malloy — semantic layer, .malloy models (browsed)">
            {rows(layerList.data).map((c) => <option key={`layer::${c.title}`} value={`layer::${c.title}`}>{String(c.title)} ({N(c.chars)} ch)</option>)}
          </optgroup>
          <optgroup label="Malloy — _meta navigation sidecars, YAML (browsed)">
            {rows(metaList.data).map((c) => <option key={`meta::${c.title}`} value={`meta::${c.title}`}>{String(c.title)} ({N(c.chars)} ch)</option>)}
          </optgroup>
          <optgroup label="Baseline — injected every prompt">
            <option value="baseline_skill">SKILL.md ({N(bSkill)} ch)</option>
          </optgroup>
          <optgroup label="Baseline — context items (browsed)">
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

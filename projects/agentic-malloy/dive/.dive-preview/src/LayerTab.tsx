import { useSQLQuery, useDiveState } from "@motherduck/react-sql-query";
import { N, rows, pct, STORY, INK, ARM, PATH, SERIF, SANS, MONO, Head, Figure, Stat, Loading, Rule, td, tdL, th, thL } from "./lib";

export default function LayerTab() {
  const vu = useSQLQuery(`SELECT view_name, file, referenced, used FROM "agentic_malloy_story"."main"."view_utilization" ORDER BY referenced DESC`);
  const rvu = useSQLQuery(`SELECT run_label, views_used FROM "agentic_malloy_story"."main"."run_view_usage" ORDER BY views_used DESC`);
  const files = useSQLQuery(`SELECT title, length(content) AS chars FROM "agentic_malloy_story"."main"."documents" WHERE kind='layer' ORDER BY chars DESC`);
  const rebuild = useSQLQuery(`SELECT layer_label, round(avg(acc_pct),1) AS avg_acc, min(correct) AS mn, max(correct) AS mx, round(avg(n)) AS n
    FROM "agentic_malloy_story"."main"."runs" WHERE arm='malloy' AND split='train' AND tier='sonnet+opus' GROUP BY layer_label`);

  const [file, setFile] = useDiveState<string>("layer_file", "");
  const body = useSQLQuery(`SELECT content FROM "agentic_malloy_story"."main"."documents" WHERE kind='layer' AND title='${file.replace(/'/g, "''")}' LIMIT 1`, { enabled: !!file });

  const views = rows(vu.data);
  const defined = views.length;
  const everUsed = views.filter((v) => v.used).length;
  const top = views.slice(0, 6);
  const off = rows(rvu.data).find((r) => String(r.run_label).endsWith("official"));
  const reb = rows(rebuild.data);
  const committed = reb.find((r) => r.layer_label === "committed");
  const rebuilt = reb.find((r) => r.layer_label === "rebuilt");

  return (
    <div>
      <Head kicker="the artifact under study" title="The semantic layer — and how little of it gets used">
        One source per entity, then joins, then views. The bytes are real; the utilization is the finding.
      </Head>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 22, margin: "2px 0 18px" }}>
        {vu.isLoading ? <Stat value="…" label="views" /> : <>
          <Stat value={String(defined)} label="views defined" />
          <Stat value={String(everUsed)} label="ever referenced" sub="across all 30 runs" />
          <Stat value={off ? String(N(off.views_used)) : "—"} label="used by the best run" color={ARM.malloy} sub={`of ${defined}`} />
          <Stat value={`${defined - everUsed}`} label="never used by any run" color={PATH.sql} sub={`${Math.round(100 * (defined - everUsed) / (defined || 1))}% dead weight`} />
        </>}
      </div>

      <Figure caption={<>Every defined view, ordered by how many submitted Malloy answers reference it. <b style={{ color: ARM.malloy }}>Filled</b> = used at least once; <b style={{ color: INK.faint }}>faint</b> = never referenced by any run. The agent reaches for SQL or re-authors inline rather than the layer.</>}>
        {vu.isLoading ? <Loading label="computing utilization…" /> : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
            {views.map((v) => (
              <div key={String(v.view_name)} title={`${v.view_name} — referenced ${N(v.referenced)}×`}
                style={{ width: 13, height: 13, borderRadius: 2, background: v.used ? ARM.malloy : "#e0ddd3",
                  opacity: v.used ? Math.min(1, 0.4 + N(v.referenced) / 40) : 1 }} />
            ))}
          </div>
        )}
      </Figure>

      <div style={{ display: "flex", gap: 30, flexWrap: "wrap", marginBottom: 8 }}>
        <div>
          <div style={{ fontFamily: SANS, fontSize: 11, letterSpacing: "0.05em", textTransform: "uppercase", color: INK.faint, marginBottom: 5 }}>distinct views used, per held-out run</div>
          {rvu.isLoading ? <Loading label="…" /> : (
            <table style={{ borderCollapse: "collapse" }}>
              <tbody>
                {rows(rvu.data).map((r) => (
                  <tr key={String(r.run_label)}>
                    <td style={{ ...tdL, fontSize: 12 }}>{String(r.run_label).replace("Malloy · ", "")}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{N(r.views_used)}<span style={{ color: INK.faint, fontWeight: 400 }}> / {defined}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <div style={{ fontFamily: SANS, fontSize: 11, letterSpacing: "0.05em", textTransform: "uppercase", color: INK.faint, marginBottom: 5 }}>the few views that carry the load</div>
          {vu.isLoading ? <Loading label="…" /> : (
            <table style={{ borderCollapse: "collapse" }}>
              <tbody>
                {top.map((v) => (
                  <tr key={String(v.view_name)}><td style={{ ...tdL, fontFamily: MONO, fontSize: 11.5 }}>{String(v.view_name)}</td><td style={td}>{N(v.referenced)}×</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Rule />

      <Head kicker="read the source" title="The model files">{`${rows(files.data).length || 11} files. Click to read the Malloy.`}</Head>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 220 }}>
          {files.isLoading ? <Loading label="…" /> : (
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr><th style={thL}>file</th><th style={th}>chars</th></tr></thead>
              <tbody>
                {rows(files.data).map((r) => (
                  <tr key={String(r.title)} style={{ cursor: "pointer", background: file === r.title ? "#eaf1f7" : "transparent" }} onClick={() => setFile(String(r.title))}>
                    <td style={{ ...tdL, fontFamily: MONO, fontSize: 11.5, color: ARM.malloy }}>{String(r.title)}</td>
                    <td style={td}>{N(r.chars).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ flex: "1 1 320px" }}>
          {file ? (body.isLoading ? <Loading label={`loading ${file}…`} /> : (
            <pre style={{ margin: 0, padding: 12, fontFamily: MONO, fontSize: 10.5, background: INK.paper, border: `1px solid ${INK.rule}`, borderRadius: 4, overflow: "auto", maxHeight: 420, whiteSpace: "pre-wrap" }}>{String(rows(body.data)[0]?.content ?? "")}</pre>
          )) : <p style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 13, color: INK.muted }}>Select a file to read its source.</p>}
        </div>
      </div>

      <Rule />

      <Head kicker="did fixing the layer help?" title="The rebuild that didn’t move the score">
        A full rebuild fixed the AVG defect at the source (build-gate findings 18→1) — but it was net-negative and was parked, not shipped.
      </Head>
      {rebuild.isLoading ? <Loading label="…" /> : (
        <div style={{ display: "flex", gap: 26, alignItems: "center", flexWrap: "wrap" }}>
          <div><div style={{ fontFamily: MONO, fontSize: 24, color: INK.text }}>{committed ? pct(committed.avg_acc) : "—"}</div><div style={{ fontSize: 11, color: INK.faint }}>committed layer · train (avg)</div></div>
          <span style={{ color: INK.faint }}>→</span>
          <div><div style={{ fontFamily: MONO, fontSize: 24, color: PATH.sql }}>{rebuilt ? `${N(rebuilt.mn)}/${N(rebuilt.n)}` : "—"}</div><div style={{ fontSize: 11, color: INK.faint }}>rebuilt layer · train</div></div>
          <p style={{ flex: "1 1 260px", fontFamily: SERIF, fontSize: 13, color: INK.muted, lineHeight: 1.5, margin: 0 }}>
            The fix recovered nothing on the score (SQL + the skill already passed those tasks), and the from-scratch regen <b>dropped the counterfactual surfaces</b> the old layer had — a net −2 on train. The substrate’s value isn’t being realized: the agent routes around the layer regardless.
          </p>
        </div>
      )}
    </div>
  );
}

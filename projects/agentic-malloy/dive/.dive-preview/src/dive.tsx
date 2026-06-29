import { useDiveState } from "@motherduck/react-sql-query";
import { INK, ARM, SERIF, SANS, TABS } from "./lib";
import StoryTab from "./StoryTab";
import MetricsTab from "./MetricsTab";
import BuildTab from "./BuildTab";
import LayerTab from "./LayerTab";
import TracesTab from "./TracesTab";

export default function StoryDive() {
  const [tab, setTab] = useDiveState<string>("tab", "story");
  return (
    <div style={{ background: INK.bg, color: INK.text, minHeight: "100vh", fontFamily: SANS }}>
      <div style={{ maxWidth: 880, margin: "0 auto", padding: "26px 22px 60px" }}>
        {/* masthead */}
        <div style={{ borderBottom: `2px solid ${INK.text}`, paddingBottom: 10, marginBottom: 4 }}>
          <div style={{ fontFamily: SANS, fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: INK.muted }}>A DABstep experiment</div>
          <h1 style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 700, color: INK.text, margin: "4px 0 0", letterSpacing: "-0.02em" }}>Malloy vs. Context</h1>
          <p style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 15, color: INK.muted, margin: "5px 0 0" }}>
            Is a semantic layer a better substrate for an analytics agent than markdown + SQL?
          </p>
        </div>

        {/* tab nav */}
        <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${INK.rule}`, margin: "14px 0 24px", flexWrap: "wrap" }}>
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                style={{ fontFamily: SANS, fontSize: 13, padding: "8px 14px", cursor: "pointer", background: "transparent",
                  border: "none", borderBottom: active ? `2px solid ${ARM.malloy}` : "2px solid transparent",
                  color: active ? ARM.malloy : INK.muted, fontWeight: active ? 700 : 500, marginBottom: -1 }}>
                {t.label}
              </button>
            );
          })}
        </div>

        {tab === "story" && <StoryTab />}
        {tab === "metrics" && <MetricsTab />}
        {tab === "build" && <BuildTab />}
        {tab === "layer" && <LayerTab />}
        {tab === "traces" && <TracesTab />}
      </div>
    </div>
  );
}

import { SchemaExplorerSidebar } from './SchemaExplorerSidebar';

export default function ChatPage() {
  return (
    <main>
      <section className="workshop-page">
        <div className="eyebrow">Step 08 · Schema explore</div>
        <h1>Give the agent a map.</h1>
        <p>
          The model can now call the schema tools, and the room can inspect the
          same tables and columns in the sidebar.
        </p>
      </section>
      <SchemaExplorerSidebar database="nba_box_scores_v2" />
    </main>
  );
}

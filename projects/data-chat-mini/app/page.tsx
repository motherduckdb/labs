export default function Home() {
  return (
    <main>
      <section className="workshop-page">
        <div className="eyebrow">Step 08 · Schema tools</div>
        <h1>Let it find its way.</h1>
        <p>
          The MCP allowlist now includes the read-only catalog tools. Open the
          schema page to inspect tables and columns while the model uses the
          same tools.
        </p>

        <div className="check">
          <p>Quick check: ask a question that needs exploration.</p>
          <pre>{`open http://localhost:3000/chat

curl -N http://localhost:3000/api/chat \\
  -H 'content-type: application/json' \\
  -d '{"message":"Most points by one player in a single 2026 playoff game?"}'`}</pre>
          <p>
            The important rule: <code>box_scores</code> is one row per player
            per period. A game total is the <code>FullGame</code> row, not the
            sum of the quarters.
          </p>
        </div>
      </section>
    </main>
  );
}

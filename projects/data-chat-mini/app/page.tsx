export default function Home() {
  return (
    <main>
      <section className="workshop-page">
        <div className="eyebrow">Step 02 · MCP query</div>
        <h1>Give the app one read-only tool.</h1>
        <p>
          The workshop agent still has no model and no loop. This checkpoint
          wires the MotherDuck MCP server and exposes only the <code>query</code>
          tool so you can call it by hand.
        </p>

        <div className="check">
          <p>Quick check: POST this SQL to <code>/api/query</code> and get rows back.</p>
          <pre>{`curl -s http://localhost:3000/api/query \\
  -H 'content-type: application/json' \\
  -d '{"query":"select count(*) as games from nba_box_scores_v2.main.schedule"}'`}</pre>
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

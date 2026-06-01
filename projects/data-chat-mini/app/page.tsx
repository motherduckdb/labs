export default function Home() {
  return (
    <main>
      <section className="workshop-page">
        <div className="eyebrow">Step 03 · Read-scaling token</div>
        <h1>Make the credential room-sized.</h1>
        <p>
          The MCP client now connects with <code>MOTHERDUCK_TOKEN</code>, a
          read-scaling token. The browser keeps a random session id and passes
          it as a hint so repeat requests can stay warm while the token fans the
          room out across read replicas.
        </p>

        <div className="check">
          <p>Quick check: POST with a session id and get rows back.</p>
          <pre>{`curl -s http://localhost:3000/api/query \\
  -H 'content-type: application/json' \\
  -H 'x-session-id: workshop-demo' \\
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

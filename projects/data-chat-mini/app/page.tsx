export default function Home() {
  return (
    <main>
      <section className="workshop-page">
        <div className="eyebrow">Step 04 · Guardrails</div>
        <h1>Reject writes before they run.</h1>
        <p>
          The MCP client now has an explicit allowlist. Only <code>query</code>
          can run; mutating tools like <code>query_rw</code> are classified but
          absent from the allowlist, so they fail in code before MotherDuck sees
          the request.
        </p>

        <div className="check">
          <p>Quick check: try the write-shaped tool and see it rejected.</p>
          <pre>{`curl -X PUT -s http://localhost:3000/api/query \\
  -H 'content-type: application/json' \\
  -d '{"tool":"query_rw","args":{"query":"create table nope as select 1"}}'`}</pre>
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

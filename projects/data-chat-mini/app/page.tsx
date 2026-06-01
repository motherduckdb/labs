export default function Home() {
  return (
    <main>
      <section className="workshop-page">
        <div className="eyebrow">Step 06 · Loop</div>
        <h1>Let the model take steps.</h1>
        <p>
          The app now has the agentic loop: ask the model, run any tool calls it
          requests, append the results, and ask again until it answers.
        </p>

        <div className="check">
          <p>Quick check: ask a question that requires a query.</p>
          <pre>{`curl -N http://localhost:3000/api/chat \\
  -H 'content-type: application/json' \\
  -d '{"message":"How many games are in the schedule table?"}'`}</pre>
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

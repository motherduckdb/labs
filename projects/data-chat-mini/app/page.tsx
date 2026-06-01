export default function Home() {
  return (
    <main>
      <section className="workshop-page">
        <div className="eyebrow">Step 12 · Context</div>
        <h1>Teach the agent.</h1>
        <p>
          The model now sees the real MotherDuck context tool names. The loop
          intercepts those calls, the browser answers from local IndexedDB, and
          the loop resumes with the result.
        </p>

        <div className="check">
          <p>Quick check: teach a definition, then ask a follow-up that uses it.</p>
          <pre>{`open http://localhost:3000/chat`}</pre>
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

export default function Home() {
  return (
    <main>
      <section className="workshop-page">
        <div className="eyebrow">Step 07 · System prompt</div>
        <h1>Give the loop habits.</h1>
        <p>
          The app now has a system prompt that teaches the model how to behave:
          explore first, stay read-only, and respect the NBA box-score grain.
        </p>

        <div className="check">
          <p>Quick check: ask the same kind of question and watch it answer with the caveat in mind.</p>
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

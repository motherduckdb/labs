export default function Home() {
  return (
    <main>
      <section className="workshop-page">
        <div className="eyebrow">Step 05 · Model</div>
        <h1>Point at the engine.</h1>
        <p>
          The app now speaks OpenRouter's OpenAI-compatible streaming API. The
          default model is <code>google/gemini-3-flash-preview</code>, with
          <code>OPENROUTER_MODEL</code> available for swaps.
        </p>

        <div className="check">
          <p>Quick check: call the model without tools and see a response.</p>
          <pre>{`curl -s http://localhost:3000/api/model \\
  -H 'content-type: application/json' \\
  -d '{"message":"Say hello to the workshop in one sentence."}'`}</pre>
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

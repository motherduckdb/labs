export default function Home() {
  return (
    <main>
      <section className="workshop-page">
        <div className="eyebrow">Step 09 · Streaming UI</div>
        <h1>Watch the loop work.</h1>
        <p>
          The app now has a streaming chat surface. Tool calls appear as they
          start and finish, and the final answer streams in as text.
        </p>

        <div className="check">
          <p>Quick check: open the chat and ask a question that needs exploration.</p>
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

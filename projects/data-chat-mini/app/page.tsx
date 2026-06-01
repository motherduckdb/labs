export default function Home() {
  return (
    <main>
      <section className="workshop-page">
        <div className="eyebrow">Step 10 · Charts</div>
        <h1>Make answers legible.</h1>
        <p>
          The loop now recognizes mviz chart fences, renders them, and streams
          inline visualizations into the chat.
        </p>

        <div className="check">
          <p>Quick check: ask for top scorers by points per game as a bar chart.</p>
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

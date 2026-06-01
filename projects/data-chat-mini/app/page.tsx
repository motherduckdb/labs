export default function Home() {
  return (
    <main>
      <section className="workshop-page">
        <div className="eyebrow">Step 11 · History</div>
        <h1>Keep the thread.</h1>
        <p>
          Conversations now persist to IndexedDB. Refresh the page, reopen the
          chat, and the thread is still available in the sidebar.
        </p>

        <div className="check">
          <p>Quick check: ask a question, refresh, then reopen it from history.</p>
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

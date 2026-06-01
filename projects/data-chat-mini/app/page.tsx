export default function Home() {
  return (
    <main>
      <section className="workshop-page">
        <div className="eyebrow">Step 01 · Data</div>
        <h1>Start with the ground truth.</h1>
        <p>
          The workshop agent starts from a MotherDuck database named
          <strong> nba_box_scores_v2</strong>. Before there is a model or a
          loop, the first checkpoint proves the data shape with a plain SQL
          query.
        </p>

        <div className="check">
          <p>Quick check: run a plain SELECT and show the grain.</p>
          <pre>{`select
  game_id,
  player_name,
  period,
  points
from nba_box_scores_v2.main.box_scores
where season_year = 2025
  and season_type = 'Playoffs'
order by game_date desc, game_id, player_name, period
limit 12;`}</pre>
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

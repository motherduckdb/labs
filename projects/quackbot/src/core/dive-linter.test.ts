import { describe, it, expect } from 'vitest';
import { lintDiveSource, formatLintAdvisory } from './dive-linter';

describe('lintDiveSource', () => {
  it('returns no violations for a correct Dive', () => {
    const source = `
      function Dive() {
        const [x, setX] = React.useState(0);
        React.useEffect(() => { console.log(x); }, [x]);
        return <div>{x}</div>;
      }
    `;
    const result = lintDiveSource(source);
    expect(result.violations).toHaveLength(0);
  });

  it('flags conditional hook calls', () => {
    const source = `
      function Dive() {
        if (Math.random() > 0.5) {
          const [x, setX] = React.useState(0);
        }
        return <div />;
      }
    `;
    const result = lintDiveSource(source);
    const rules = result.violations.map(v => v.rule);
    expect(rules).toContain('react-hooks/rules-of-hooks');
  });

  it('flags missing effect deps', () => {
    const source = `
      function Dive({ id }) {
        React.useEffect(() => { console.log(id); }, []);
        return <div />;
      }
    `;
    const result = lintDiveSource(source);
    const rules = result.violations.map(v => v.rule);
    expect(rules).toContain('react-hooks/exhaustive-deps');
  });

  it('returns empty on parse error instead of throwing', () => {
    const result = lintDiveSource('function Dive() { return <div');
    expect(result.violations).toEqual([]);
  });

  it('formatLintAdvisory returns empty string when clean', () => {
    expect(formatLintAdvisory({ violations: [] })).toBe('');
  });

  it('formatLintAdvisory renders violations as a block', () => {
    const text = formatLintAdvisory({
      violations: [{ rule: 'react-hooks/rules-of-hooks', line: 3, message: 'conditional hook', severity: 'error' }],
    });
    expect(text).toContain('Dive lint');
    expect(text).toContain('rules-of-hooks');
    expect(text).toContain('line 3');
  });
});

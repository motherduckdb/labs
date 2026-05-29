import { describe, it, expect } from 'vitest';
import { buildDiveViewerHtml, extractRequiredDatabases } from './dive-viewer';

const baseParams = {
  source: 'export default function Dive() { return <div>hi</div>; }',
  title: 'Test Dive',
  diveId: 'dive-uuid-123',
  slt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc',
  mdServerURL: 'https://api.motherduck.com',
};

describe('buildDiveViewerHtml — title escaping', () => {
  it('escapes <, >, &, " in the <title> tag', () => {
    const html = buildDiveViewerHtml({
      ...baseParams,
      title: `<script>alert("xss")</script> & "quotes"`,
    });
    // The raw payload must NOT appear in the document title.
    expect(html).not.toContain('<title><script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  it('escapes title in the loading placeholder too, not just the <title> tag', () => {
    const html = buildDiveViewerHtml({
      ...baseParams,
      title: '<img src=x onerror=alert(1)>',
    });
    // Check the specific loading phrase where title is interpolated.
    expect(html).toMatch(/Loading &lt;img src=x onerror=alert\(1\)&gt;/);
    // And never the raw tag.
    expect(html).not.toMatch(/Loading <img src=x/);
  });

  it('does not break valid plain-text titles', () => {
    const html = buildDiveViewerHtml({ ...baseParams, title: 'Plain Title' });
    expect(html).toContain('<title>Plain Title</title>');
    expect(html).toContain('Loading Plain Title...');
  });
});

describe('buildDiveViewerHtml — error paths use textContent', () => {
  it('assigns to errDiv.textContent, never errDiv.innerHTML', () => {
    const html = buildDiveViewerHtml(baseParams);
    // The two error branches (missing DiveComponent, render throw) both set
    // .textContent. innerHTML on an error message would re-introduce the
    // injection surface escaping is trying to close.
    expect(html).toContain('errDiv.textContent');
    expect(html).not.toContain('errDiv.innerHTML');
    // Guard against regressions — any `.innerHTML =` on a new element would
    // need explicit review. This file should never grow one.
    expect(html).not.toMatch(/\.innerHTML\s*=/);
  });
});

describe('buildDiveViewerHtml — SLT sanitization', () => {
  it('strips characters that fall outside the JWT charset [A-Za-z0-9._-]', () => {
    // Inject an SLT containing a quote + angle bracket + backslash. The
    // sanitizer must drop them before JSON.stringify lands the value in the
    // inline <script> where a quote-break would escape the string literal.
    const html = buildDiveViewerHtml({
      ...baseParams,
      slt: `bad"<>token;alert(1)//`,
    });
    // After sanitization, the embedded token must be quote-safe.
    const match = html.match(/var __SLT = "([^"]*)"/);
    expect(match).not.toBeNull();
    const embedded = match![1];
    // Only characters from the JWT-safe set survive.
    expect(embedded).toMatch(/^[A-Za-z0-9._-]*$/);
    expect(embedded).not.toContain('"');
    expect(embedded).not.toContain('<');
    expect(embedded).not.toContain('>');
  });

  it('passes a well-formed JWT-shaped SLT through unchanged', () => {
    const slt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc-_def';
    const html = buildDiveViewerHtml({ ...baseParams, slt });
    expect(html).toContain(`var __SLT = "${slt}"`);
  });

  it('emits an empty string when SLT is omitted', () => {
    const html = buildDiveViewerHtml({ ...baseParams, slt: undefined });
    expect(html).toContain('var __SLT = ""');
  });
});

describe('buildDiveViewerHtml — mdServerURL whitelist', () => {
  it('accepts a well-formed https URL with no port/path', () => {
    const html = buildDiveViewerHtml({ ...baseParams, mdServerURL: 'https://api.motherduck.com' });
    expect(html).toContain('var __MD_SERVER_URL = "https://api.motherduck.com"');
  });

  it('rejects http:// URLs', () => {
    const html = buildDiveViewerHtml({ ...baseParams, mdServerURL: 'http://api.motherduck.com' });
    expect(html).toContain('var __MD_SERVER_URL = ""');
  });

  it('rejects javascript: and other non-https schemes', () => {
    const html1 = buildDiveViewerHtml({ ...baseParams, mdServerURL: 'javascript:alert(1)' });
    expect(html1).toContain('var __MD_SERVER_URL = ""');
    const html2 = buildDiveViewerHtml({ ...baseParams, mdServerURL: 'file:///etc/passwd' });
    expect(html2).toContain('var __MD_SERVER_URL = ""');
  });

  it('rejects URLs with a path or query string (whitelist only accepts host-only)', () => {
    const html = buildDiveViewerHtml({ ...baseParams, mdServerURL: 'https://evil.com/path?x=1' });
    expect(html).toContain('var __MD_SERVER_URL = ""');
  });

  it('rejects URLs whose host contains characters outside [A-Za-z0-9.-]', () => {
    const html = buildDiveViewerHtml({
      ...baseParams,
      mdServerURL: 'https://bad_host.example.com', // underscore
    });
    expect(html).toContain('var __MD_SERVER_URL = ""');
  });

  it('emits empty when mdServerURL is omitted', () => {
    const { mdServerURL: _, ...rest } = baseParams;
    void _;
    const html = buildDiveViewerHtml(rest);
    expect(html).toContain('var __MD_SERVER_URL = ""');
  });
});

describe('buildDiveViewerHtml — source encoding', () => {
  it('embeds the raw source as base64 in a JSON-typed <script> tag', () => {
    // Issue #132: source is no longer pre-rewritten server-side. Babel's
    // transform-modules-commonjs plugin handles imports/exports in-browser,
    // and `module.exports.default` is read after eval. The base64 wrapper
    // here is just to keep arbitrary source bytes (incl. `</script>` and
    // multi-byte UTF-8) out of the top-level HTML.
    const source = 'export default function Dive() { return <div>hello</div>; }';
    const html = buildDiveViewerHtml({ ...baseParams, source });
    const match = html.match(/<script id="dive-source" type="application\/json">"([^"]+)"/);
    expect(match).not.toBeNull();
    const decoded = Buffer.from(match![1], 'base64').toString('utf-8');
    expect(decoded).toBe(source);
  });

  it('does not emit the legacy dive-default-export / dive-lucide-bindings tags', () => {
    // Pre-#132 the server pre-extracted the default export name and lucide
    // import bindings into separate script tags. With Babel's modules
    // transform doing this in-browser, those tags are gone — guard against
    // a regression that re-introduces server-side parsing.
    const html = buildDiveViewerHtml({
      ...baseParams,
      source: 'import { Search } from "lucide-react"; export default function MyDive() { return <Search />; }',
    });
    expect(html).not.toContain('id="dive-default-export"');
    expect(html).not.toContain('id="dive-lucide-bindings"');
  });

  it('configures Babel with transform-modules-commonjs so ES exports compile to module.exports', () => {
    const html = buildDiveViewerHtml(baseParams);
    expect(html).toContain("plugins: ['transform-modules-commonjs']");
    // The component lookup must read from the CommonJS module bag, not eval
    // a captured identifier name.
    expect(html).toContain('module.exports.default');
  });

  it('does not declare a lucide prelude that would shadow JS builtins like Map', () => {
    // Lucide exports an icon named \`Map\`. A naive prelude that declares
    // \`var Map = Lucide['Map']\` would shadow the JS Map constructor in
    // every dive's compiled scope, breaking \`new Map()\`. The recharts
    // prelude is fine (no recharts export collides with a builtin), but
    // lucide must come in via explicit imports + the require shim instead.
    const html = buildDiveViewerHtml(baseParams);
    expect(html).not.toMatch(/var\s+Map\s*=\s*Lucide/);
    // Also defensively guard against future re-introduction by name:
    expect(html).not.toContain('lucidePrelude');
  });

  it('exposes the @motherduck/react-sql-query SDK to dive imports', () => {
    // Dives import `useSQLQuery` from this scoped package (per the official
    // dive guide). With Babel's CJS transform the import compiles to a
    // require() call — the require shim must map the package to a stub
    // that re-exports useSQLQueryImpl so `_motherduckReactSqlQuery.useSQLQuery`
    // resolves at runtime. Without this entry the previous-rewriter regression
    // surface shifts from "Unexpected token 'export'" to "useSQLQuery is not
    // a function".
    const html = buildDiveViewerHtml(baseParams);
    expect(html).toContain("'@motherduck/react-sql-query'");
    expect(html).toContain('useSQLQuery: useSQLQueryImpl');
  });

  it('round-trips multi-byte UTF-8 in the source via base64', () => {
    // Emoji + CJK + combining marks — atob in the browser would mishandle
    // these without the base64 wrapper, so the invariant is load-bearing.
    const source = 'const msg = "👋 こんにちは — café";';
    const html = buildDiveViewerHtml({ ...baseParams, source });
    const match = html.match(/<script id="dive-source" type="application\/json">"([^"]+)"/);
    const decoded = Buffer.from(match![1], 'base64').toString('utf-8');
    expect(decoded).toBe(source);
  });

  it('does not leak raw source text into the top-level HTML (XSS/CSP surface)', () => {
    const source = '</script><script>alert("pwnd")</script>';
    const html = buildDiveViewerHtml({ ...baseParams, source });
    // The payload must NOT appear verbatim; only its base64 encoding should.
    expect(html).not.toContain('alert("pwnd")');
    expect(html).not.toContain('</script><script>');
  });
});

describe('buildDiveViewerHtml — structural invariants', () => {
  it('emits a doctype + <html lang="en">', () => {
    const html = buildDiveViewerHtml(baseParams);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
  });

  it('loads React 18 (not 19) — UMD reconciler must match the lucide pin', () => {
    const html = buildDiveViewerHtml(baseParams);
    expect(html).toContain('react@18');
    expect(html).toContain('react-dom@18');
  });

  it('pins lucide-react to React 18 via esm.sh ?deps= to keep element shape stable', () => {
    const html = buildDiveViewerHtml(baseParams);
    expect(html).toContain('lucide-react@0.469.0?deps=react@18.3.1');
  });

  it('loads the MotherDuck WASM client from esm.sh', () => {
    const html = buildDiveViewerHtml(baseParams);
    expect(html).toContain('@motherduck/wasm-client');
  });
});

describe('extractRequiredDatabases', () => {
  it('returns [] when REQUIRED_DATABASES is absent', () => {
    expect(extractRequiredDatabases('export default function D() { return null; }')).toEqual([]);
  });

  it('parses a typical share declaration with single quotes and unquoted keys', () => {
    const src = `
      export const REQUIRED_DATABASES = [
        { type: 'share', path: 'md:_share/foo/abc-123', alias: 'foo' }
      ];
      export default function D() { return null; }
    `;
    const got = extractRequiredDatabases(src);
    expect(got).toEqual([{ type: 'share', path: 'md:_share/foo/abc-123', alias: 'foo' }]);
  });

  it('parses multiple entries', () => {
    const src = `
      export const REQUIRED_DATABASES = [
        { type: 'share', path: 'md:_share/foo/1', alias: 'foo' },
        { type: 'share', path: 'md:_share/bar/2', alias: 'bar' }
      ];
    `;
    expect(extractRequiredDatabases(src)).toHaveLength(2);
  });

  it('accepts an inline TS type annotation', () => {
    const src = `
      export const REQUIRED_DATABASES: Array<{path: string; alias: string}> = [
        { path: 'md:_share/foo/1', alias: 'foo' }
      ];
    `;
    expect(extractRequiredDatabases(src)).toEqual([{ path: 'md:_share/foo/1', alias: 'foo' }]);
  });

  it('returns [] on a malformed literal rather than throwing', () => {
    const src = `export const REQUIRED_DATABASES = [ { type: 'share', `;
    expect(extractRequiredDatabases(src)).toEqual([]);
  });

  // Server-side parse path runs in the Next process while building the
  // iframe HTML. The sandbox doesn't protect this code path, so any
  // attempt to embed executable JS (function calls, template literals,
  // getters, IIFEs) MUST be rejected and yield an empty list.
  it('rejects function-call injection (no eval, returns [])', () => {
    const src = `
      export const REQUIRED_DATABASES = [
        { type: 'share', path: (process.mainModule.require('child_process').execSync('id').toString()), alias: 'x' }
      ];
    `;
    expect(extractRequiredDatabases(src)).toEqual([]);
  });

  it('rejects template-literal injection', () => {
    const src = `
      export const REQUIRED_DATABASES = [
        { type: 'share', path: \`\${process.env.SECRET}\`, alias: 'x' }
      ];
    `;
    expect(extractRequiredDatabases(src)).toEqual([]);
  });

  it('rejects IIFE / getter shapes', () => {
    const src = `
      export const REQUIRED_DATABASES = [
        { get path() { return 'evil' } }
      ];
    `;
    expect(extractRequiredDatabases(src)).toEqual([]);
  });

  it('rejects operator expressions in values', () => {
    const src = `
      export const REQUIRED_DATABASES = [
        { path: 'a' + 'b' }
      ];
    `;
    expect(extractRequiredDatabases(src)).toEqual([]);
  });

  it('accepts trailing commas and JS5 mixed quoting', () => {
    const src = `
      export const REQUIRED_DATABASES = [
        { type: 'share', path: "md:_share/foo/abc", alias: 'foo', },
      ];
    `;
    expect(extractRequiredDatabases(src)).toEqual([
      { type: 'share', path: 'md:_share/foo/abc', alias: 'foo' },
    ]);
  });
});

describe('buildDiveViewerHtml — REQUIRED_DATABASES wiring', () => {
  it('inlines REQUIRED_DATABASES as a JS array for ATTACH', () => {
    const html = buildDiveViewerHtml({
      ...baseParams,
      source: `
        export const REQUIRED_DATABASES = [
          { type: 'share', path: 'md:_share/nba/abc', alias: 'nba' }
        ];
        export default function D() { return null; }
      `,
    });
    expect(html).toContain('var __REQUIRED_DATABASES = ');
    expect(html).toContain('"md:_share/nba/abc"');
    expect(html).toContain('"alias":"nba"');
    expect(html).toContain('attachRequiredDatabases');
  });

  it('escapes `<` in the JSON to prevent </script> breakouts', () => {
    const html = buildDiveViewerHtml({
      ...baseParams,
      source: `
        export const REQUIRED_DATABASES = [
          { path: 'md:_share/x</script>', alias: 'x' }
        ];
      `,
    });
    // The dangerous closing-script sequence must NOT appear verbatim inside
    // the inlined JSON; the `<` should be unicode-escaped.
    const startMarker = 'var __REQUIRED_DATABASES =';
    const segment = html.slice(html.indexOf(startMarker), html.indexOf(';', html.indexOf(startMarker)) + 1);
    expect(segment).not.toContain('</script>');
    expect(segment).toContain('\\u003c/script>');
  });

  it('emits an empty array when no REQUIRED_DATABASES declaration is present', () => {
    const html = buildDiveViewerHtml({
      ...baseParams,
      source: 'export default function D() { return null; }',
    });
    expect(html).toContain('var __REQUIRED_DATABASES = []');
  });
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface RequiredDatabase {
  type?: string;
  path?: string;
  alias?: string;
}

/**
 * Extract `export const REQUIRED_DATABASES = [...]` from dive source.
 *
 * Production MotherDuck's renderer honors this declaration by ATTACHing the
 * named shares before any `useSQLQuery` runs. Without it, a dive that
 * queries `"shared_db"."main"."table"` blanks in the iframe — the WASM
 * client has no record of `shared_db`.
 *
 * Parsing runs SERVER-SIDE in the Next process while building the iframe
 * HTML. Dive source is user/model-controlled, so the parser must NEVER
 * evaluate it as JavaScript (otherwise a crafted initializer can execute
 * arbitrary Node code before the response is returned — the iframe
 * sandbox does not protect this code path). `parseDataLiteral` below
 * accepts only data-shaped JS5 tokens (arrays, objects, strings,
 * numbers, booleans, null/undefined) and rejects function calls,
 * template literals, getters, anything operator-shaped — so the worst
 * outcome on hostile input is an empty array.
 */
export function extractRequiredDatabases(source: string): RequiredDatabase[] {
  const m = source.match(
    /export\s+const\s+REQUIRED_DATABASES\s*(?::\s*[^=]+)?\s*=\s*(\[[\s\S]*?\])\s*;?\s*(?:\n|$)/,
  );
  if (!m) return [];
  try {
    const parsed = parseDataLiteral(m[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is RequiredDatabase => Boolean(x) && typeof x === 'object');
  } catch (err) {
    console.warn('[dive-viewer] Failed to parse REQUIRED_DATABASES:', err);
    return [];
  }
}

/**
 * Safe recursive-descent parser for a restricted JS5-ish literal grammar:
 *
 *   value  := array | object | string | number | bool | null | undefined
 *   array  := '[' (value (',' value)* ','?)? ']'
 *   object := '{' (entry (',' entry)* ','?)? '}'
 *   entry  := (string | identifier) ':' value
 *   string := '"' chars '"' | "'" chars "'"        (with \n \t \r \\ \" \' escapes)
 *
 * Whitespace allowed between tokens. Anything else — `(`, ` `${`, `${...}`,
 * template literals, operators, function-call syntax, comments — throws
 * and the caller returns `[]`. This is the only safe shape for parsing
 * user/model-controlled metadata in a server process.
 */
function parseDataLiteral(input: string): unknown {
  let i = 0;
  const src = input;

  function ws(): void {
    while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) {
      i++;
    }
  }

  function expect(ch: string): void {
    if (src[i] !== ch) throw new Error(`expected '${ch}' at ${i}, got '${src[i] ?? 'EOF'}'`);
    i++;
  }

  function parseString(): string {
    const quote = src[i];
    if (quote !== '"' && quote !== "'") throw new Error(`string expected at ${i}`);
    i++;
    let out = '';
    while (i < src.length && src[i] !== quote) {
      const c = src[i];
      if (c === '\\') {
        i++;
        const esc = src[i++];
        switch (esc) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case '\\': out += '\\'; break;
          case '"': out += '"'; break;
          case "'": out += "'"; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          default: throw new Error(`unsupported escape \\${esc} at ${i}`);
        }
      } else if (c === '\n' || c === '\r') {
        throw new Error(`unterminated string at ${i}`);
      } else {
        out += c;
        i++;
      }
    }
    if (src[i] !== quote) throw new Error('unterminated string');
    i++;
    return out;
  }

  function parseIdentifier(): string {
    const start = i;
    if (!/[A-Za-z_$]/.test(src[i] ?? '')) throw new Error(`identifier expected at ${i}`);
    i++;
    while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) i++;
    return src.slice(start, i);
  }

  function parseNumber(): number {
    const start = i;
    if (src[i] === '-') i++;
    if (!/[0-9.]/.test(src[i] ?? '')) throw new Error(`number expected at ${start}`);
    while (i < src.length && /[0-9]/.test(src[i])) i++;
    if (src[i] === '.') {
      i++;
      while (i < src.length && /[0-9]/.test(src[i])) i++;
    }
    if (src[i] === 'e' || src[i] === 'E') {
      i++;
      if (src[i] === '+' || src[i] === '-') i++;
      while (i < src.length && /[0-9]/.test(src[i])) i++;
    }
    const n = Number(src.slice(start, i));
    if (Number.isNaN(n)) throw new Error(`invalid number at ${start}`);
    return n;
  }

  function parseValue(): unknown {
    ws();
    const ch = src[i];
    if (ch === undefined) throw new Error('unexpected end of input');
    if (ch === '[') return parseArray();
    if (ch === '{') return parseObject();
    if (ch === '"' || ch === "'") return parseString();
    if (ch === '-' || /[0-9.]/.test(ch)) return parseNumber();
    if (/[A-Za-z_$]/.test(ch)) {
      const id = parseIdentifier();
      if (id === 'true') return true;
      if (id === 'false') return false;
      if (id === 'null') return null;
      if (id === 'undefined') return undefined;
      throw new Error(`unexpected identifier '${id}' at ${i - id.length}`);
    }
    throw new Error(`unexpected token '${ch}' at ${i}`);
  }

  function parseArray(): unknown[] {
    expect('[');
    ws();
    const out: unknown[] = [];
    if (src[i] === ']') {
      i++;
      return out;
    }
    while (true) {
      out.push(parseValue());
      ws();
      if (src[i] === ',') {
        i++;
        ws();
        if (src[i] === ']') {
          i++;
          return out;
        }
        continue;
      }
      if (src[i] === ']') {
        i++;
        return out;
      }
      throw new Error(`expected ',' or ']' at ${i}`);
    }
  }

  function parseObject(): Record<string, unknown> {
    expect('{');
    ws();
    const out: Record<string, unknown> = {};
    if (src[i] === '}') {
      i++;
      return out;
    }
    while (true) {
      ws();
      const ch = src[i];
      let key: string;
      if (ch === '"' || ch === "'") key = parseString();
      else if (ch !== undefined && /[A-Za-z_$]/.test(ch)) key = parseIdentifier();
      else throw new Error(`object key expected at ${i}`);
      ws();
      expect(':');
      out[key] = parseValue();
      ws();
      if (src[i] === ',') {
        i++;
        ws();
        if (src[i] === '}') {
          i++;
          return out;
        }
        continue;
      }
      if (src[i] === '}') {
        i++;
        return out;
      }
      throw new Error(`expected ',' or '}' at ${i}`);
    }
  }

  const result = parseValue();
  ws();
  if (i !== src.length) throw new Error(`trailing content at ${i}`);
  return result;
}

/**
 * Generates an HTML page that renders a MotherDuck Dive component.
 *
 * Source flow (issue #132): the raw TSX source is base64-encoded and passed
 * to the iframe verbatim. In-browser, Babel-standalone compiles JSX/TS *and*
 * transforms ES module syntax to CommonJS via the `transform-modules-commonjs`
 * plugin. We supply a `require` shim that maps bare specifiers (`react`,
 * `recharts`, `lucide-react`, …) to globals already loaded on the page, and
 * read `module.exports.default` to find the component. This replaces a
 * regex-based source rewriter that produced repeat #111 regressions whenever
 * a dive used a JS form the lexer hadn't seen — with a real parser doing the
 * job, that whole class of bug goes away.
 */
export function buildDiveViewerHtml(params: {
  source: string;
  title: string;
  diveId: string;
  slt?: string;
  mdServerURL?: string;
}): string {
  const { source, title, slt, mdServerURL } = params;

  const sourceBase64 = Buffer.from(source, 'utf-8').toString('base64');
  // Cheap heuristic — if the source mentions lucide at all, wait for the
  // lucide-react ESM bundle to load before booting. False positives (the
  // string appears in a comment) cost ~5s in the worst case via the timeout
  // fallback below.
  const needsLucide = source.includes('lucide-react');

  const sltEscaped = (slt || '').replace(/[^a-zA-Z0-9._\-]/g, '');
  const mdServerURLSafe = mdServerURL && /^https:\/\/[a-zA-Z0-9.\-]+$/.test(mdServerURL) ? mdServerURL : '';

  // Required databases — ATTACH these to the WASM connection before any
  // useSQLQuery runs. Serialize via JSON; escape `<` so the JSON can't break
  // out of its <script> context. Only keep entries with a usable path+alias.
  const requiredDatabases = extractRequiredDatabases(source)
    .filter((db) => typeof db.path === 'string' && typeof db.alias === 'string')
    .map((db) => ({ path: db.path!, alias: db.alias! }));
  const requiredDatabasesJson = JSON.stringify(requiredDatabases).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>

  <!-- Tailwind CSS -->
  <script crossorigin="anonymous" src="https://cdn.tailwindcss.com"><\/script>

  <!-- React -->
  <script crossorigin="anonymous" src="https://unpkg.com/react@18/umd/react.development.js"><\/script>
  <script crossorigin="anonymous" src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"><\/script>

  <!-- PropTypes (required by Recharts) -->
  <script crossorigin="anonymous" src="https://unpkg.com/prop-types@15/prop-types.min.js"><\/script>

  <!-- Babel for JSX + module compilation. crossorigin so the window.error
       handler below gets a real Error object (with stack) instead of the
       sanitized "Script error." that browsers serve for opaque cross-origin
       scripts. unpkg returns Access-Control-Allow-Origin:* so anonymous is
       fine. Same reason on Recharts / Tailwind / PropTypes / React above. -->
  <script crossorigin="anonymous" src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script>

  <!-- Recharts -->
  <script crossorigin="anonymous" src="https://unpkg.com/recharts@2/umd/Recharts.js"><\/script>

  <style>
    /* Cascade 100% height through html/body/root so dive components written
       with style height 100% actually measure to the iframe rect. Without
       this, ResponsiveContainer computes 0x0 and the chart renders blank
       even with non-empty data — which is exactly what blanks the dive in
       mdw-turbo while it renders fine in MotherDuck (which wraps every dive
       in an explicit fixed-height container). */
    html, body, #root { height: 100%; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .dive-error { padding: 24px; color: #bc1200; font-size: 14px; white-space: pre-wrap; }
    .dive-loading { padding: 24px; color: #6a6a6a; font-size: 14px; display: flex; align-items: center; gap: 8px; }
    .dive-loading .dot { width: 6px; height: 6px; border-radius: 50%; background: #0777b3; animation: pulse 1s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
    /* Live debug HUD — surfaces useSQLQuery errors / connection failures so
       the user doesn't need iframe devtools to see what's breaking. */
    #__dive-debug { display: none; position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
      background: #fff5f5; border-bottom: 1px solid #fecaca; color: #991b1b;
      font: 12px/1.4 -apple-system, system-ui, sans-serif; padding: 8px 12px;
      max-height: 40%; overflow: auto; }
    #__dive-debug.has-errors { display: block; }
    #__dive-debug .dive-debug-row { padding: 4px 0; border-top: 1px solid #fecaca; }
    #__dive-debug .dive-debug-row:first-child { border-top: none; }
    #__dive-debug pre { margin: 4px 0 0; white-space: pre-wrap; font: 11px/1.3 ui-monospace, Menlo, monospace; color: #7a1818; }
  </style>
</head>
<body>
  <div id="__dive-debug" aria-live="polite"></div>
  <div id="root"><div class="dive-loading"><span class="dot"></span> Loading ${escapeHtml(title)}...</div></div>

  <!-- Raw dive source. Imports + exports are handled in-browser by Babel's
       transform-modules-commonjs plugin (see bootDive). -->
  <script id="dive-source" type="application/json">"${sourceBase64}"<\/script>

  <!-- Load MotherDuck WASM client as ES module, expose on window.
       Pinned to the latest published client (1.5.2-r.3). DuckDB-Wasm under
       it falls back to a single-threaded, non-SharedArrayBuffer bundle when
       the page is not cross-origin-isolated, so this renders without any
       COOP/COEP headers on the host. -->
  <script type="module">
    import { MDConnection } from 'https://esm.sh/@motherduck/wasm-client@1.5.2-r.3/with-arrow';
    window.__MDConnection = MDConnection;
    window.__mdReady = true;
    window.dispatchEvent(new CustomEvent('md-wasm-ready'));
  <\/script>

  <!-- Load lucide-react as ES module, expose on window.
       ?deps=react@18.3.1 pins esm.sh's peer so lucide's internal
       React.createElement calls produce React-18-shaped elements
       (Symbol.for('react.element')) — otherwise esm.sh defaults to
       React 19, whose 'react.transitional.element' shape our UMD
       React 18 reconciler can't render ("Objects are not valid as
       a React child"). -->
  <script type="module">
    import * as Lucide from 'https://esm.sh/lucide-react@0.469.0?deps=react@18.3.1';
    window.__Lucide = Lucide;
    window.dispatchEvent(new CustomEvent('lucide-ready'));
  <\/script>

  <script>
    var __SLT = ${JSON.stringify(sltEscaped)};
    var __MD_SERVER_URL = ${JSON.stringify(mdServerURLSafe)};
    var __NEEDS_LUCIDE = ${needsLucide};
    var __REQUIRED_DATABASES = ${requiredDatabasesJson};
    var __connection = null;
    var __connectionPromise = null;

    /** Append a row to the visible debug banner + console.error. Surfaces
     *  query / connection failures without requiring iframe devtools. */
    function __surfaceError(label, err, extra) {
      try {
        var msg = (err && (err.message || err.toString())) || String(err);
        console.error('[dive-viewer] ' + label + ':', err, extra || '');
        var host = document.getElementById('__dive-debug');
        if (!host) return;
        var row = document.createElement('div');
        row.className = 'dive-debug-row';
        var head = document.createElement('div');
        head.textContent = label + ': ' + msg;
        head.style.fontWeight = '600';
        row.appendChild(head);
        if (extra) {
          var pre = document.createElement('pre');
          pre.textContent = typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2);
          row.appendChild(pre);
        }
        host.appendChild(row);
        host.classList.add('has-errors');
      } catch (e) { /* never let the surfacer crash */ }
    }

    window.addEventListener('error', function(e) {
      // When a cross-origin <script> throws without CORS headers, browsers
      // sanitize e.error to null and e.message to "Script error." — we'd
      // surface a useless banner. The location fields (filename/lineno) are
      // still populated, so at least name the offending script. With
      // crossorigin="anonymous" on the unpkg/cdn scripts above this branch
      // should rarely fire, but keep the fallback for any future inline.
      var err = e.error;
      if (!err && /script error/i.test(String(e.message || ''))) {
        var loc = (e.filename || '?') + ':' + (e.lineno || '?') + ':' + (e.colno || '?');
        __surfaceError('window error (opaque)', e.message + ' at ' + loc,
          'Browser hid the real error — likely a third-party script throwing without CORS. ' +
          'Open DevTools console for the un-sanitized message.');
        return;
      }
      __surfaceError('window error', err || e.message);
    });
    window.addEventListener('unhandledrejection', function(e) {
      __surfaceError('unhandled rejection', e.reason);
    });

    /* Forward double-clicks to the parent so the canvas card host can use
     * them for "enter / exit selection" — iframes swallow pointer events
     * by default, and we need the card chrome to toggle without putting a
     * pointer-blocking overlay over the iframe (which would kill chart
     * tooltips and other dive interactivity). Use the capture phase so
     * dive code can't preventDefault us out. */
    document.addEventListener('dblclick', function() {
      if (window.parent && window.parent !== window) {
        try { window.parent.postMessage({ type: '__dive_dblclick' }, '*'); } catch (e) { /* ignore */ }
      }
    }, true);

    /**
     * ATTACH each entry in REQUIRED_DATABASES so the WASM client can resolve
     * "shared_db"."schema"."table" references. Mirrors production renderer
     * behavior. Single-quote paths (SQL string literals) and double-quote
     * aliases (SQL identifiers); escape any embedded quotes. \`IF NOT EXISTS\`
     * keeps the call idempotent when the user's account already has the
     * database attached (common for shares pinned to their workspace).
     */
    function attachRequiredDatabases(conn) {
      if (!Array.isArray(__REQUIRED_DATABASES) || __REQUIRED_DATABASES.length === 0) {
        return Promise.resolve(conn);
      }
      var p = Promise.resolve();
      __REQUIRED_DATABASES.forEach(function(db) {
        if (!db || typeof db.path !== 'string' || typeof db.alias !== 'string') return;
        var path = db.path.replace(/'/g, "''");
        var alias = db.alias.replace(/"/g, '""');
        var sql = "ATTACH IF NOT EXISTS '" + path + "' AS \\"" + alias + "\\"";
        p = p.then(function() {
          return conn.evaluateQuery(sql).catch(function(err) {
            console.warn('[dive-viewer] ATTACH failed for ' + db.alias + ':', err);
          });
        });
      });
      return p.then(function() { return conn; });
    }

    function getConnection() {
      if (__connectionPromise) return __connectionPromise;
      __connectionPromise = new Promise(function(resolve, reject) {
        function init() {
          if (!window.__MDConnection) {
            window.addEventListener('md-wasm-ready', init, { once: true });
            return;
          }
          try {
            if (!__SLT) throw new Error('No MotherDuck token available');
            var __opts = { mdToken: __SLT };
            if (__MD_SERVER_URL) __opts.mdServerURL = __MD_SERVER_URL;
            __connection = window.__MDConnection.create(__opts);
            __connection.isInitialized()
              .then(function() { return attachRequiredDatabases(__connection); })
              .then(function() { resolve(__connection); })
              .catch(function(err) {
                __surfaceError('connection init failed', err);
                reject(err);
              });
          } catch (err) {
            __surfaceError('getConnection threw', err);
            reject(err);
          }
        }
        init();
      });
      return __connectionPromise;
    }

    var queryCache = new Map();
    var inflightQueries = new Map();

    function coerceBigInts(rows) {
      if (!Array.isArray(rows)) return rows;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!r || typeof r !== 'object') continue;
        for (var k in r) {
          var v = r[k];
          if (typeof v === 'bigint') r[k] = Number(v);
        }
      }
      return rows;
    }

    function useSQLQueryImpl(sql, options) {
      var enabled = options && options.enabled !== undefined ? options.enabled : true;
      var _state = React.useState({ data: [], isLoading: enabled, error: null });
      var state = _state[0];
      var setState = _state[1];

      React.useEffect(function() {
        if (!enabled || !sql) {
          setState({ data: [], isLoading: false, error: null });
          return;
        }

        var cacheKey = sql.trim();

        if (queryCache.has(cacheKey)) {
          setState({ data: queryCache.get(cacheKey), isLoading: false, error: null });
          return;
        }

        if (inflightQueries.has(cacheKey)) {
          inflightQueries.get(cacheKey).then(function(data) {
            setState({ data: data, isLoading: false, error: null });
          }).catch(function(err) {
            setState({ data: [], isLoading: false, error: err });
          });
          return;
        }

        setState(function(prev) { return Object.assign({}, prev, { isLoading: true }); });

        var promise = getConnection()
          .then(function(conn) { return conn.evaluateQuery(sql); })
          .then(function(result) {
            var data = [];
            if (result && result.data && typeof result.data.toRows === 'function') {
              data = result.data.toRows();
            } else if (Array.isArray(result)) {
              data = result;
            }
            // DuckDB BIGINT / HUGEINT / UBIGINT columns come back as JS BigInt
            // through the WASM client. Recharts and most chart libs do
            // arithmetic like Math.max(bigint, number) which throws
            // "Cannot convert a BigInt value to a number". Coerce to Number
            // for chart-data ergonomics. Loses precision above 2^53, which is
            // fine for visualization payloads (counts, sums, scores) — if a
            // dive ever needs exact BigInt precision it can read raw data via
            // its own connection and bypass this hook.
            data = coerceBigInts(data);
            queryCache.set(cacheKey, data);
            inflightQueries.delete(cacheKey);
            return data;
          });

        inflightQueries.set(cacheKey, promise);

        promise.then(function(data) {
          setState({ data: data, isLoading: false, error: null });
        }).catch(function(err) {
          inflightQueries.delete(cacheKey);
          __surfaceError('useSQLQuery failed', err, sql.trim().slice(0, 400));
          setState({ data: [], isLoading: false, error: err });
        });
      }, [sql, enabled]);

      return state;
    }

    var RechartsComponents = window.Recharts || {};

    function bootDive() {
      var compiled = '';
      try {
        var sourceB64 = JSON.parse(document.getElementById('dive-source').textContent);
        var binary = atob(sourceB64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        var source = new TextDecoder('utf-8').decode(bytes);

        // Bare globals available to Dive code without imports — the
        // LLM-generated style. Dives that DO use imports get the same
        // bindings via the require shim further down; the local var is
        // shadowed inside their compiled scope.
        var useState = React.useState;
        var useEffect = React.useEffect;
        var useCallback = React.useCallback;
        var useMemo = React.useMemo;
        var useRef = React.useRef;
        var Fragment = React.Fragment;
        var useSQLQuery = useSQLQueryImpl;
        var Lucide = window.__Lucide || {};

        // Recharts prelude: bare references like <BarChart> resolve without
        // an explicit import. Recharts identifiers are domain-specific
        // (BarChart, Pie, Cell, Tooltip, …) and don't collide with JS or DOM
        // builtins, so dumping them all is safe.
        //
        // Lucide does NOT get the same prelude. Lucide exports include icon
        // names like \`Map\`, which would shadow the global \`Map\`
        // constructor in the dive's compiled scope and break \`new Map()\`.
        // Dives must import lucide explicitly per the official dive guide;
        // those imports resolve through the require shim below. (Pre-#132
        // the rewriter only declared the imports it had pre-extracted, so
        // \`Map\` was never shadowed in practice — the all-exports approach
        // I tried first widened the surface and broke this.)
        var rechartsPrelude = Object.keys(RechartsComponents)
          .filter(function(n) { return /^[A-Z][A-Za-z0-9_$]*$/.test(n); })
          .map(function(n) { return 'var ' + n + ' = RechartsComponents[' + JSON.stringify(n) + '];'; })
          .join('\\n');

        var preludedSource = rechartsPrelude + '\\n' + source;

        compiled = Babel.transform(preludedSource, {
          presets: ['react', 'typescript'],
          plugins: ['transform-modules-commonjs'],
          filename: 'dive.tsx',
          sourceType: 'module',
        }).code;

        // CommonJS module bag for Babel's transformed output to write to.
        // ES exports become assignments to exports.default / exports.X;
        // imports become require() calls resolved by the shim below.
        var module = { exports: {} };
        var exports = module.exports;

        // The MotherDuck dive SDK that production dives import from. We
        // expose useSQLQuery via the same impl that backs the bare-global
        // path (the LLM-generated style); useExport and the SDK provider
        // are stubs — dives that exercise them would have failed in the
        // old rewriter path too, since it stripped imports without
        // providing replacements.
        var motherduckSDK = {
          useSQLQuery: useSQLQueryImpl,
          useExport: function () {
            return {
              exportQuery: function () {
                return Promise.reject(new Error('exportQuery is not supported in the embedded dive viewer'));
              },
            };
          },
          // useDiveState is production-only — the real hook persists to the
          // URL fragment so state survives a refresh and travels via shared
          // links. The embedded preview has no shareable URL, so we stub
          // with plain useState. Same call shape useDiveState(key, initial)
          // returning [value, setValue], just no fragment round-trip. Without
          // this stub, dives that destructure the return value crash with
          // "(0, _reactSqlQuery.useDiveState) is not a function or its return
          // value is not iterable".
          useDiveState: function (key, initialValue) {
            // Ignore key — preview-only, no cross-callsite sharing or
            // persistence. The production hook keys are URL-fragment slots;
            // here every callsite gets its own React state.
            return React.useState(initialValue);
          },
          useConnection: function () { return null; },
          useConnectionStatus: function () {
            return { isConnected: true, isConnecting: false, error: null };
          },
          MotherDuckSDKProvider: function (props) { return props.children; },
        };

        // Bare-specifier resolver for the React + dive ecosystem. Anything
        // not in this map returns an empty stub so a stray import doesn't
        // crash the whole dive — we'd rather see a "BarChart is undefined"
        // at the call site than a "module not found" at boot.
        var moduleMap = {
          'react': React,
          'react-dom': ReactDOM,
          'react/jsx-runtime': React,
          'react/jsx-dev-runtime': React,
          'recharts': RechartsComponents,
          'lucide-react': Lucide,
          '@motherduck/react-sql-query': motherduckSDK,
        };
        var moduleCache = {};
        function require(id) {
          if (id in moduleCache) return moduleCache[id];
          var src = moduleMap[id];
          var out;
          if (src && typeof src === 'object') {
            // __esModule + default makes Babel's _interopRequireDefault and
            // _interopRequireWildcard helpers see a "real" ES module shape;
            // both \`import X from 'foo'\` and \`import { Y } from 'foo'\`
            // resolve through the same wrapper.
            out = { __esModule: true, default: src };
            for (var k in src) {
              if (k !== 'default' && k !== '__esModule') out[k] = src[k];
            }
          } else {
            console.warn('[dive-viewer] unknown import: ' + id);
            out = { __esModule: true, default: {} };
          }
          moduleCache[id] = out;
          return out;
        }

        eval(compiled);

        // Default-export landing zones, in order of likelihood:
        //   - module.exports.default        (ES \`export default X\`)
        //   - module.exports                (TS \`export = X\` overwrites the bag)
        //   - first function-typed named export (LLM produced \`export { Foo }\`
        //     without a default)
        var DiveComponent = (module.exports && module.exports.default) || null;
        if (typeof DiveComponent !== 'function' && typeof module.exports === 'function') {
          DiveComponent = module.exports;
        }
        if (typeof DiveComponent !== 'function' && module.exports && typeof module.exports === 'object') {
          for (var ek in module.exports) {
            if (ek !== 'default' && ek !== '__esModule' && typeof module.exports[ek] === 'function') {
              DiveComponent = module.exports[ek];
              break;
            }
          }
        }

        if (typeof DiveComponent !== 'function') {
          var errDiv = document.createElement('div');
          errDiv.className = 'dive-error';
          errDiv.textContent = 'Could not find a Dive component (no default export, no named function export).';
          document.getElementById('root').replaceChildren(errDiv);
          return;
        }

        var ErrorBoundary = (function() {
          function EB(props) {
            this.state = { error: null };
          }
          EB.prototype = Object.create(React.Component.prototype);
          EB.prototype.constructor = EB;
          EB.getDerivedStateFromError = function(error) { return { error: error }; };
          EB.prototype.render = function() {
            if (this.state.error) {
              return React.createElement('div', {
                style: { padding: '12px', margin: '8px 0', background: '#fff5f5', border: '1px solid #fecaca', borderRadius: '6px', fontSize: '12px', color: '#991b1b' }
              }, 'Component error: ' + this.state.error.message);
            }
            return this.props.children;
          };
          return EB;
        })();

        var root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(React.createElement(ErrorBoundary, null, React.createElement(DiveComponent)));
      } catch (err) {
        // Diagnostic for #111-class regressions: dump the compiled source
        // (Babel's full output incl. modules transform) and the offending
        // line. The original source is in the dive-source script tag, so
        // users can copy both into a bug report.
        console.error('Dive render error:', err);
        try {
          var msg = (err && err.message) || '';
          var lineMatch = msg.match(/\\((\\d+):(\\d+)\\)/);
          if (lineMatch && compiled) {
            var lines = compiled.split('\\n');
            var ln = Math.max(0, Number(lineMatch[1]) - 1);
            console.error('[dive-viewer] compiled line ' + (ln + 1) + ': ' + (lines[ln] || '').slice(0, 400));
          }
          if (compiled) console.error('[dive-viewer] full compiled source:\\n' + compiled);
        } catch { /* swallow */ }
        var errDiv = document.createElement('div');
        errDiv.className = 'dive-error';
        errDiv.textContent = 'Render error: ' + err.message;
        document.getElementById('root').replaceChildren(errDiv);
      }
    }

    (function() {
      if (!__NEEDS_LUCIDE || window.__Lucide) {
        bootDive();
      } else {
        var booted = false;
        var go = function() { if (!booted) { booted = true; bootDive(); } };
        window.addEventListener('lucide-ready', go, { once: true });
        setTimeout(go, 5000);
      }
    })();
  <\/script>
</body>
</html>`;
}

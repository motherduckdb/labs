function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Content-Security-Policy for the Dive viewer document.
 *
 * The viewer runs arbitrary Dive source but holds NO MotherDuck token —
 * queries go to the server-side proxy (`/api/dives/query`), which holds the
 * token. The CSP's jobs:
 *   1. `sandbox allow-scripts` (NO `allow-same-origin`) → opaque origin, so the
 *      Dive can't touch the app's cookies/storage or call our authenticated
 *      APIs with the session cookie, even if opened directly as a top page.
 *   2. `default-src 'none'` + tight allowlist limits where a Dive could
 *      exfiltrate query results (or its short-lived capability): `connect-src`
 *      is only the app origin (the proxy) + esm.sh (lucide module deps).
 *
 * Because the iframe is opaque-origin, `connect-src 'self'` would NOT match the
 * app origin — so we pass the explicit `appOrigin`.
 */
export function buildDiveViewerCsp(appOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://unpkg.com https://esm.sh",
    `connect-src ${appOrigin} https://esm.sh`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    'sandbox allow-scripts',
  ].join('; ');
}

export interface RequiredDatabase {
  type?: string;
  path?: string;
  alias?: string;
}

/**
 * Extract `export const REQUIRED_DATABASES = [...]` from dive source.
 *
 * Parsing runs SERVER-SIDE while building the iframe HTML. Dive source is
 * user/model-controlled, so the parser must NEVER evaluate it as JavaScript.
 * `parseDataLiteral` accepts only data-shaped JS5 tokens (arrays, objects,
 * strings, numbers, booleans, null/undefined) and rejects function calls,
 * template literals, getters, operators — so the worst outcome on hostile
 * input is an empty array.
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

/** Safe recursive-descent parser for a restricted JS5-ish data literal. */
function parseDataLiteral(input: string): unknown {
  let i = 0;
  const src = input;

  function ws(): void {
    while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) i++;
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
    if (src[i] === '.') { i++; while (i < src.length && /[0-9]/.test(src[i])) i++; }
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
    if (src[i] === ']') { i++; return out; }
    while (true) {
      out.push(parseValue());
      ws();
      if (src[i] === ',') { i++; ws(); if (src[i] === ']') { i++; return out; } continue; }
      if (src[i] === ']') { i++; return out; }
      throw new Error(`expected ',' or ']' at ${i}`);
    }
  }
  function parseObject(): Record<string, unknown> {
    expect('{');
    ws();
    const out: Record<string, unknown> = {};
    if (src[i] === '}') { i++; return out; }
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
      if (src[i] === ',') { i++; ws(); if (src[i] === '}') { i++; return out; } continue; }
      if (src[i] === '}') { i++; return out; }
      throw new Error(`expected ',' or '}' at ${i}`);
    }
  }

  const result = parseValue();
  ws();
  if (i !== src.length) throw new Error(`trailing content at ${i}`);
  return result;
}

/**
 * Generate the HTML page that renders a Dive.
 *
 * The Dive runs against a faithful port of the `@motherduck/react-sql-query`
 * SDK (the same surface the local dive-preview harness uses): `useSQLQuery`
 * with full status/select/placeholderData semantics, `useConnection`,
 * `useConnectionStatus`, `useDiveState`, `useExport`, `MotherDuckSDKProvider`.
 * The ONE swap vs. that harness: the SDK's connection is a **proxy
 * connection** whose `safeEvaluateQuery` POSTs to `/api/dives/query` (the
 * encrypted `capability` authenticates it) instead of an in-browser WASM
 * MDConnection — so no MotherDuck token is ever in the page.
 */
export function buildDiveViewerHtml(params: {
  source: string;
  title: string;
  diveId: string;
  capability: string;
  appOrigin: string;
}): string {
  const { source, title, diveId, capability, appOrigin } = params;

  const sourceBase64 = Buffer.from(source, 'utf-8').toString('base64');
  const needsLucide = source.includes('lucide-react');

  // requiredDatabases are NOT sent from here — they're bound into the
  // capability server-side (see the view route) so the proxy ATTACHes exactly
  // the dive's declared shares, not iframe-supplied ones.
  const queryEndpoint = `${appOrigin}/api/dives/query`;
  const csp = buildDiveViewerCsp(appOrigin);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
  <title>${escapeHtml(title)}</title>

  <script crossorigin="anonymous" src="https://cdn.tailwindcss.com"><\/script>
  <script crossorigin="anonymous" src="https://unpkg.com/react@18.3.1/umd/react.development.js"><\/script>
  <script crossorigin="anonymous" src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js"><\/script>
  <script crossorigin="anonymous" src="https://unpkg.com/prop-types@15.8.1/prop-types.min.js"><\/script>
  <script crossorigin="anonymous" src="https://unpkg.com/@babel/standalone@7.26.4/babel.min.js"><\/script>
  <script crossorigin="anonymous" src="https://unpkg.com/recharts@2.15.4/umd/Recharts.js"><\/script>

  <style>
    html, body, #root { height: 100%; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .dive-error { padding: 24px; color: #bc1200; font-size: 14px; white-space: pre-wrap; }
    .dive-loading { padding: 24px; color: #6a6a6a; font-size: 14px; display: flex; align-items: center; gap: 8px; }
    .dive-loading .dot { width: 6px; height: 6px; border-radius: 50%; background: #0777b3; animation: pulse 1s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
    #__dive-debug { display: none; position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
      background: #fff5f5; border-bottom: 1px solid #fecaca; color: #991b1b;
      font: 12px/1.4 -apple-system, system-ui, sans-serif; padding: 8px 12px; max-height: 40%; overflow: auto; }
    #__dive-debug.has-errors { display: block; }
    #__dive-debug .dive-debug-row { padding: 4px 0; border-top: 1px solid #fecaca; }
    #__dive-debug pre { margin: 4px 0 0; white-space: pre-wrap; font: 11px/1.3 ui-monospace, Menlo, monospace; color: #7a1818; }
  </style>
</head>
<body>
  <div id="__dive-debug" aria-live="polite"></div>
  <div id="root"><div class="dive-loading"><span class="dot"></span> Loading ${escapeHtml(title)}...</div></div>

  <script id="dive-source" type="application/json">"${sourceBase64}"<\/script>

  <script type="module">
    import * as Lucide from 'https://esm.sh/lucide-react@0.469.0?deps=react@18.3.1';
    window.__Lucide = Lucide;
    window.dispatchEvent(new CustomEvent('lucide-ready'));
  <\/script>

  <script>
    var __CAPABILITY = ${JSON.stringify(capability)};
    var __QUERY_ENDPOINT = ${JSON.stringify(queryEndpoint)};
    var __DIVE_ID = ${JSON.stringify(diveId)};
    var __NEEDS_LUCIDE = ${needsLucide};

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
      __surfaceError('window error', e.error || e.message);
    });
    window.addEventListener('unhandledrejection', function(e) {
      __surfaceError('unhandled rejection', e.reason);
    });

    /* ── Proxy connection: replaces the in-browser WASM MDConnection. Its
     *    safeEvaluateQuery POSTs to the server proxy (the encrypted capability
     *    authenticates); the MotherDuck token never enters this page. Returns
     *    the SDK's expected result shape so useSQLQuery is unchanged. Sent as
     *    text/plain to avoid a CORS preflight. */
    var __proxyConnection = {
      safeEvaluateQuery: function(sql) {
        return fetch(__QUERY_ENDPOINT, {
          method: 'POST',
          body: JSON.stringify({ capability: __CAPABILITY, sql: sql, diveId: __DIVE_ID })
        }).then(function(res) {
          if (!res.ok) {
            return res.json().catch(function() { return {}; }).then(function(b) {
              return { status: 'error', err: new Error(b && b.error ? b.error : ('Query failed (' + res.status + ')')) };
            });
          }
          return res.json().then(function(j) {
            var rows = (j && Array.isArray(j.rows)) ? j.rows : [];
            return { status: 'success', result: { data: { toRows: function() { return rows; } } } };
          });
        }).catch(function(e) {
          return { status: 'error', err: e instanceof Error ? e : new Error(String(e)) };
        });
      }
    };

    /* ── @motherduck/react-sql-query shim (ported from the dive-preview
     *    harness), backed by __proxyConnection. Same public API the Dive SDK
     *    exposes: useSQLQuery (status/select/placeholderData/refetch),
     *    useConnection, useConnectionStatus, useDiveState, useExport,
     *    MotherDuckSDKProvider. */
    var MDSDK = (function() {
      var React = window.React;

      function QueryObserver() {
        this.state = { status: 'idle', data: undefined, error: undefined, hasHadData: false, lastData: undefined };
        this.listeners = new Set();
        this.token = 0;
      }
      QueryObserver.prototype.subscribe = function(l) { var self = this; this.listeners.add(l); return function() { self.listeners.delete(l); }; };
      QueryObserver.prototype.getSnapshot = function() { return this.state; };
      QueryObserver.prototype.getStatus = function() { return this.state.status; };
      QueryObserver.prototype._set = function(u) {
        this.state = Object.assign({}, this.state, u);
        this.listeners.forEach(function(l) { l(); });
      };
      QueryObserver.prototype.execute = function(connection, sql) {
        var self = this;
        var my = ++this.token;
        this._set({ status: 'loading', data: undefined, error: undefined });
        Promise.resolve()
          .then(function() { return connection.safeEvaluateQuery(sql); })
          .then(function(result) {
            if (my !== self.token) return;
            if (result.status === 'error') {
              self._set({ status: 'error', error: result.err, data: undefined });
              __surfaceError('useSQLQuery failed', result.err, sql);
              return;
            }
            var data = result.result.data.toRows();
            self._set({ status: 'success', data: data, error: undefined, hasHadData: true, lastData: data });
          })
          .catch(function(err) {
            if (my !== self.token) return;
            self._set({ status: 'error', error: err, data: undefined });
            __surfaceError('useSQLQuery failed', err, sql);
          });
      };
      QueryObserver.prototype.reset = function() { this.token++; this._set({ status: 'idle', data: undefined, error: undefined }); };
      QueryObserver.prototype.cancel = function() { this.token++; };

      // Always-connected context backed by the proxy connection. No token,
      // no provider required — bare useSQLQuery (LLM style) works too.
      var connectedState = { status: 'connected', connection: __proxyConnection };
      var SDKContext = React.createContext({ state: connectedState });

      function useSDKContext() { return React.useContext(SDKContext); }

      function MotherDuckSDKProvider(props) {
        // Token (if passed) is ignored — execution is server-side via the proxy.
        return React.createElement(SDKContext.Provider, { value: { state: connectedState } }, props.children);
      }

      function useSQLQuery(sql, options) {
        options = options || {};
        var ctx = useSDKContext();
        var connState = ctx.state;
        var observerRef = React.useRef(null);
        if (!observerRef.current) observerRef.current = new QueryObserver();
        var observer = observerRef.current;

        var snap = React.useSyncExternalStore(observer.subscribe.bind(observer), observer.getSnapshot.bind(observer), observer.getSnapshot.bind(observer));
        var enabled = options.enabled !== false;

        React.useEffect(function() {
          if (!enabled || !sql || connState.status !== 'connected') {
            if (observer.getStatus() !== 'idle') observer.reset();
            return;
          }
          observer.execute(connState.connection, sql);
          return function() { observer.cancel(); };
        }, [sql, enabled, connState, observer]);

        var refetch = React.useCallback(function() {
          if (connState.status === 'connected' && enabled) observer.execute(connState.connection, sql);
        }, [observer, connState, enabled, sql]);

        var isLoading = snap.status === 'loading' || connState.status === 'connecting';
        var rawData = snap.data !== undefined ? snap.data : snap.lastData;
        var transformed = (rawData === undefined) ? undefined : (options.select ? options.select(rawData) : rawData);

        var data, isPlaceholderData = false;
        if (transformed !== undefined) {
          data = transformed;
        } else if (!snap.hasHadData && options.initialData !== undefined) {
          data = options.initialData;
        } else if (isLoading && options.placeholderData !== undefined) {
          var ph = (typeof options.placeholderData === 'function') ? options.placeholderData(transformed) : options.placeholderData;
          if (ph !== undefined) { data = ph; isPlaceholderData = true; }
        }

        return {
          data: data, isLoading: isLoading,
          isSuccess: snap.status === 'success', isError: snap.status === 'error',
          isPlaceholderData: isPlaceholderData, error: snap.error || null,
          refetch: refetch, status: snap.status,
        };
      }

      function useConnection() {
        var ctx = useSDKContext();
        return ctx.state.status === 'connected' ? ctx.state.connection : null;
      }
      function useConnectionStatus() {
        var ctx = useSDKContext();
        return { isConnected: ctx.state.status === 'connected', isConnecting: false, error: null };
      }
      // Preview-only: per-callsite React state (no URL-fragment persistence).
      function useDiveState(key, initialValue) { return React.useState(initialValue); }
      function useExport() {
        return { exportQuery: function() { return Promise.reject(new Error('export is not supported in the embedded dive viewer')); } };
      }

      return {
        MotherDuckSDKProvider: MotherDuckSDKProvider,
        useSQLQuery: useSQLQuery,
        useConnection: useConnection,
        useConnectionStatus: useConnectionStatus,
        useDiveState: useDiveState,
        useExport: useExport,
      };
    })();

    var RechartsComponents = window.Recharts || {};

    function bootDive() {
      var compiled = '';
      try {
        var sourceB64 = JSON.parse(document.getElementById('dive-source').textContent);
        var binary = atob(sourceB64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        var source = new TextDecoder('utf-8').decode(bytes);

        var useState = React.useState;
        var useEffect = React.useEffect;
        var useCallback = React.useCallback;
        var useMemo = React.useMemo;
        var useRef = React.useRef;
        var Fragment = React.Fragment;
        var useSQLQuery = MDSDK.useSQLQuery;
        var Lucide = window.__Lucide || {};

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

        var module = { exports: {} };
        var exports = module.exports;

        var moduleMap = {
          'react': React,
          'react-dom': ReactDOM,
          'react/jsx-runtime': React,
          'react/jsx-dev-runtime': React,
          'recharts': RechartsComponents,
          'lucide-react': Lucide,
          '@motherduck/react-sql-query': MDSDK,
        };
        var moduleCache = {};
        function require(id) {
          if (id in moduleCache) return moduleCache[id];
          var src = moduleMap[id];
          var out;
          if (src && typeof src === 'object') {
            out = { __esModule: true, default: src };
            for (var k in src) { if (k !== 'default' && k !== '__esModule') out[k] = src[k]; }
          } else {
            console.warn('[dive-viewer] unknown import: ' + id);
            out = { __esModule: true, default: {} };
          }
          moduleCache[id] = out;
          return out;
        }

        eval(compiled);

        var DiveComponent = (module.exports && module.exports.default) || null;
        if (typeof DiveComponent !== 'function' && typeof module.exports === 'function') DiveComponent = module.exports;
        if (typeof DiveComponent !== 'function' && module.exports && typeof module.exports === 'object') {
          for (var ek in module.exports) {
            if (ek !== 'default' && ek !== '__esModule' && typeof module.exports[ek] === 'function') { DiveComponent = module.exports[ek]; break; }
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
          function EB() { this.state = { error: null }; }
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

        // Wrap in the SDK provider so useSQLQuery's context resolves (the
        // context also defaults to connected, so bare usage works too).
        var root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(
          React.createElement(ErrorBoundary, null,
            React.createElement(MDSDK.MotherDuckSDKProvider, { token: '' },
              React.createElement(DiveComponent)))
        );
      } catch (err) {
        console.error('Dive render error:', err);
        try { if (compiled) console.error('[dive-viewer] compiled source:\\n' + compiled); } catch (e) { /* */ }
        var errDiv2 = document.createElement('div');
        errDiv2.className = 'dive-error';
        errDiv2.textContent = 'Render error: ' + err.message;
        document.getElementById('root').replaceChildren(errDiv2);
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

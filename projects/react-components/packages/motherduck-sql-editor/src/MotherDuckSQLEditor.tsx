import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';

import { MotherDuckSQLEditorProps, SqlRow } from './types';
import { validateQuerySecurity } from './validation';
import { APP_NAME, DEFAULT_QUERY, FONT_CONFIG, MOTHERDUCK_URL, WASM_EXTENSION_VERSION } from './constants';
import { formatSql } from './utils/sqlFormatter';
import { getSqlTheme } from './utils/syntaxTheme';
import { PlayIcon, DuckFeetLogo, CopyIcon, FormatIcon } from './Icons';
import { DatabaseDisplay } from './DatabaseDisplay';
import { LoadingSpinner } from './LoadingSpinner';
import SortableTable from './SortableTable';
import {
  fetchMotherDuckToken,
  getAuth0ReactContext,
  getAuth0TokenBridge,
  logout as authLogout,
  redirectToAuth0Login,
  storeAuth0TokenBridge,
} from './auth';
import styles from './styles.module.css';

const canUseDOM = typeof window !== 'undefined' && typeof document !== 'undefined';

// Conditionally require wasm-client to avoid SSR breakage.
let MDConnection: any;
if (canUseDOM) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wasmClient = require('@motherduck/wasm-client');
  MDConnection = wasmClient.MDConnection;
}

class MDConnectionManager {
  private static instance: MDConnectionManager;
  private connection: any = null;
  private token: string | null = null;
  private database: string | null = null;
  private initPromise: Promise<void> | null = null;
  private listeners: Set<() => void> = new Set();
  private isProvisioning = false;
  private provisioningPromises: Map<string, Promise<void>> = new Map();
  private provisionedDatabases: Set<string> = new Set();

  static getInstance(): MDConnectionManager {
    if (!MDConnectionManager.instance) {
      MDConnectionManager.instance = new MDConnectionManager();
    }
    return MDConnectionManager.instance;
  }

  async getConnection(
    mdToken: string,
    database: string,
    provisioning: MotherDuckSQLEditorProps['provisioning'],
  ): Promise<any> {
    // Reset on ANY change including token — otherwise a second user logging in
    // with the same database would re-use the prior user's connection via the
    // awaited `initPromise` (which lingers across the fast-path skip).
    if (this.connection && (this.database !== database || this.token !== mdToken)) {
      await this.resetConnectionState();
    }

    if (this.connection && this.token === mdToken && this.database === database) {
      return this.connection;
    }

    const ongoing = Array.from(this.provisioningPromises.values());
    if (ongoing.length > 0) await Promise.all(ongoing);

    if (!this.initPromise) {
      // Clear initPromise if initialization rejects, otherwise every later
      // call would await the same cached rejection forever — even after the
      // user corrects props or a transient failure clears.
      this.initPromise = this.initializeConnection(mdToken, database, provisioning).catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }

    await this.initPromise;
    return this.connection;
  }

  async reset(): Promise<void> {
    await this.resetConnectionState();
  }

  private async initializeConnection(
    mdToken: string,
    database: string,
    provisioning: MotherDuckSQLEditorProps['provisioning'],
  ): Promise<void> {
    if (!canUseDOM || !MDConnection) {
      throw new Error('MDConnection not available');
    }

    if (provisioning) {
      await this.ensureDatabaseProvisioned(mdToken, database, provisioning);
    }

    this.connection = MDConnection.create({
      mdToken,
      attachMode: 'workspace',
      useDuckDBWasmCOI: false,
      extensionVersion: WASM_EXTENSION_VERSION,
    });
    await this.connection.isInitialized();
    this.token = mdToken;
    this.database = database;
    this.notifyListeners();
  }

  getIsProvisioning(): boolean {
    return this.isProvisioning;
  }

  async ensureActiveDatabase(database: string): Promise<void> {
    if (!this.connection) throw new Error('No connection available');
    await this.connection.evaluateQuery(`USE ${database};`);
  }

  private async ensureDatabaseProvisioned(
    mdToken: string,
    database: string,
    provisioning: NonNullable<MotherDuckSQLEditorProps['provisioning']>,
  ): Promise<void> {
    if (this.provisionedDatabases.has(database)) return;
    const existing = this.provisioningPromises.get(database);
    if (existing) {
      await existing;
      return;
    }

    const promise =
      provisioning.mode === 'create-empty'
        ? this.provisionCreateEmpty(mdToken, database)
        : this.provisionAttachShare(mdToken, database, provisioning.shareUrls);

    this.provisioningPromises.set(database, promise);
    this.isProvisioning = true;
    this.notifyListeners();

    try {
      await promise;
      this.provisionedDatabases.add(database);
    } finally {
      this.provisioningPromises.delete(database);
      if (this.provisioningPromises.size === 0) {
        this.isProvisioning = false;
        this.notifyListeners();
      }
    }
  }

  private async provisionCreateEmpty(mdToken: string, database: string): Promise<void> {
    const conn = MDConnection.create({
      mdToken,
      attachMode: 'workspace',
      useDuckDBWasmCOI: false,
      extensionVersion: WASM_EXTENSION_VERSION,
    });
    try {
      await conn.isInitialized();
      const result = await conn.evaluateQuery(
        `SELECT name FROM MD_INFORMATION_SCHEMA.DATABASES WHERE name='${database}'`,
      );
      const exists = result.type === 'materialized' && result.data.numRows > 0;
      if (!exists) {
        try {
          await conn.evaluateQuery(`CREATE DATABASE ${database}`);
        } catch (err: any) {
          if (!err.message?.includes('already exists')) throw err;
        }
      }
    } finally {
      if (typeof conn.close === 'function') {
        try {
          await conn.close();
        } catch {
          /* noop */
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async provisionAttachShare(mdToken: string, database: string, shareUrls: string[]): Promise<void> {
    const conn = MDConnection.create({
      mdToken,
      attachMode: 'workspace',
      useDuckDBWasmCOI: false,
      extensionVersion: WASM_EXTENSION_VERSION,
    });
    try {
      await conn.isInitialized();
      const check = await conn.evaluateQuery(
        `SELECT fully_qualified_name FROM md_all_databases() WHERE database_name='${database}'`,
      );
      const alreadyAttached = check.type === 'materialized' && check.data.numRows > 0;
      if (alreadyAttached) return;

      let lastErr: any = null;
      for (const url of shareUrls) {
        try {
          await conn.evaluateQuery(`ATTACH '${url}' AS ${database}`);
          return;
        } catch (err: any) {
          if (err.message?.includes('already attached')) return;
          lastErr = err;
        }
      }
      if (lastErr) throw lastErr;
    } finally {
      if (typeof conn.close === 'function') {
        try {
          await conn.close();
        } catch {
          /* noop */
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async resetConnectionState(): Promise<void> {
    if (this.connection && typeof this.connection.close === 'function') {
      try {
        await this.connection.close();
      } catch {
        /* noop */
      }
    }
    this.connection = null;
    this.token = null;
    this.database = null;
    this.initPromise = null;
    this.provisioningPromises.clear();
    this.provisionedDatabases.clear();
    this.isProvisioning = false;
  }

  addListener(listener: () => void): void {
    this.listeners.add(listener);
  }
  removeListener(listener: () => void): void {
    this.listeners.delete(listener);
  }
  private notifyListeners(): void {
    this.listeners.forEach((l) => l());
  }
}

const fetchFreshMotherDuckToken = async (): Promise<string | null> => {
  const ctx = getAuth0ReactContext();
  if (!ctx || ctx.isLoading) return null;

  if (ctx.isAuthenticated) {
    try {
      const claims = await ctx.getIdTokenClaims();
      if (claims?.__raw) {
        storeAuth0TokenBridge(claims.__raw);
        return await fetchMotherDuckToken(claims.__raw);
      }
    } catch (err) {
      console.error('Failed to get token via Auth0 SDK:', err);
    }
  }

  const bridgeToken = getAuth0TokenBridge();
  if (bridgeToken) return fetchMotherDuckToken(bridgeToken);
  return null;
};

const useColorMode = (override?: 'light' | 'dark'): 'light' | 'dark' => {
  const [mode, setMode] = useState<'light' | 'dark'>(override ?? 'light');
  useEffect(() => {
    if (override) {
      setMode(override);
      return;
    }
    if (!canUseDOM || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    setMode(mql.matches ? 'dark' : 'light');
    const handler = (e: MediaQueryListEvent) => setMode(e.matches ? 'dark' : 'light');
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [override]);
  return mode;
};

const MotherDuckSQLEditor: FC<MotherDuckSQLEditorProps> = ({
  query = DEFAULT_QUERY,
  formatOnLoad = true,
  database,
  colorMode: colorModeProp,
  provisioning,
}) => {
  const { isAuthenticated, isLoading: authLoading } = useAuth0();
  const colorMode = useColorMode(colorModeProp);
  const sqlTheme = getSqlTheme(colorMode);

  const initialQuery = formatOnLoad ? formatSql(query) : query;
  const [sql, setSql] = useState<string>(initialQuery);
  const [result, setResult] = useState<SqlRow[] | null>(null);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [token, setToken] = useState<string | null>(null);
  const [connection, setConnection] = useState<any | null>(null);
  const [tokenInClipboard, setTokenInClipboard] = useState<boolean>(false);
  const [copySuccess, setCopySuccess] = useState<boolean>(false);
  const [formatSuccess, setFormatSuccess] = useState<boolean>(false);
  const [hasMounted, setHasMounted] = useState<boolean>(false);
  const [isProvisioning, setIsProvisioning] = useState<boolean>(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const authInitializedRef = useRef<boolean>(false);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    if (!hasMounted || !canUseDOM) return;
    const manager = MDConnectionManager.getInstance();
    const update = () => setIsProvisioning(manager.getIsProvisioning());
    update();
    manager.addListener(update);
    return () => manager.removeListener(update);
  }, [hasMounted]);

  const connectWithToken = useCallback(
    async (mdToken: string) => {
      if (!canUseDOM || !MDConnection) return;
      if (connection && token) return;

      setLoading(true);
      setError('');
      try {
        const manager = MDConnectionManager.getInstance();
        const conn = await manager.getConnection(mdToken, database, provisioning);
        setConnection(conn);
        setToken(mdToken);

        // Clean up Auth0 query params from the URL after successful connect.
        const params = new URLSearchParams(window.location.search);
        if (params.has('code') || params.has('state') || params.has('error')) {
          const cleanUrl = `${window.location.origin}${window.location.pathname}`;
          window.history.replaceState({}, document.title, cleanUrl);
        }
      } catch (err: any) {
        setError(`Connection error: ${err.message || String(err)}`);
      } finally {
        setLoading(false);
      }
    },
    [connection, token, database, provisioning],
  );

  useEffect(() => {
    if (!hasMounted || !canUseDOM || authInitializedRef.current) return;
    authInitializedRef.current = true;

    const init = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const returningFromAuth0 = params.has('code') || params.has('state') || params.has('error');
        const maxRetries = returningFromAuth0 ? 12 : 3;

        let token: string | null = null;
        let attempt = 0;
        while (!token && attempt < maxRetries) {
          token = await fetchFreshMotherDuckToken();
          if (!token) {
            attempt++;
            if (attempt < maxRetries) {
              const baseDelay = returningFromAuth0 ? 800 : 300;
              await new Promise((r) => setTimeout(r, baseDelay * (1 + attempt * 0.5)));
            }
          }
        }
        if (token) await connectWithToken(token);
      } catch (err) {
        console.error('Auth initialization error:', err);
      }
    };
    init();
  }, [hasMounted, connectWithToken]);

  useEffect(() => {
    setSql(formatOnLoad ? formatSql(query) : query);
  }, [query, formatOnLoad, database]);

  useEffect(() => {
    if (!hasMounted || !canUseDOM || connection) return;
    if (isAuthenticated && !authLoading && !connection) {
      (async () => {
        const t = await fetchFreshMotherDuckToken();
        if (t) await connectWithToken(t);
      })();
    }
  }, [hasMounted, connection, connectWithToken, isAuthenticated, authLoading]);

  useEffect(() => {
    if (!hasMounted || !canUseDOM) return;
    const checkForToken = async () => {
      const url = new URL(window.location.href);
      if (url.searchParams.get('tokenInClipboard')) {
        if (navigator.clipboard?.readText) {
          try {
            const clipboardToken = await navigator.clipboard.readText();
            if (clipboardToken) {
              url.searchParams.delete('tokenInClipboard');
              history.pushState({}, '', url);
              await connectWithToken(clipboardToken);
              return;
            }
          } catch {
            /* clipboard may be denied */
          }
        }
        setTokenInClipboard(true);
      }
    };
    checkForToken();
  }, [hasMounted, connectWithToken]);

  const handleAuth0RedirectLogin = useCallback(async () => {
    try {
      setLoading(true);
      await redirectToAuth0Login();
    } catch (err: any) {
      setError(`Login error: ${err.message || String(err)}`);
      setLoading(false);
    }
  }, []);

  const handleGetToken = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('tokenInClipboard', 'y');
    window.location.href = `${MOTHERDUCK_URL}/token-request?appName=${encodeURIComponent(APP_NAME)}&returnTo=${encodeURIComponent(url.toString())}`;
  }, []);

  const handleLogout = useCallback(async () => {
    setConnection(null);
    setToken(null);
    // Drop the singleton's cached connection too — otherwise the next login
    // (potentially as a different user) would reuse this token's connection.
    await MDConnectionManager.getInstance().reset();
    await authLogout();
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(sql);
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2000);
  }, [sql]);

  const handleFormat = useCallback(() => {
    setSql(formatSql(sql));
    setFormatSuccess(true);
    setTimeout(() => setFormatSuccess(false), 2000);
  }, [sql]);

  async function runQuery() {
    if (!connection) {
      setError('Please login to run SQL queries');
      return;
    }
    setLoading(true);
    setError('');
    setResult(null);

    try {
      const securityCheck = validateQuerySecurity(sql, database);
      if (!securityCheck.isValid) {
        setError(securityCheck.error || 'Query blocked for security reasons');
        setLoading(false);
        return;
      }
      const manager = MDConnectionManager.getInstance();
      await manager.ensureActiveDatabase(database);

      const res = await connection.evaluateQuery(sql);
      if (res.type === 'materialized') {
        setResult([...res.data.toRows()]);
      } else {
        setResult(null);
        setError('Streaming results not supported in this editor.');
      }
    } catch (err: any) {
      setError(err.message || String(err));
    }
    setLoading(false);
  }

  const columns =
    result && result.length > 0
      ? Object.keys(result[0]).map((col) => ({ accessorKey: col, header: col }))
      : [];

  if (!canUseDOM || !hasMounted) {
    return (
      <div className={styles.placeholder}>
        <div className={styles.sqlEditor}>
          <div className={styles.editorContainer}>
            <SyntaxHighlighter
              language='sql'
              style={sqlTheme}
              customStyle={{ margin: 0, padding: FONT_CONFIG.padding, minHeight: '120px' }}
            >
              {sql}
            </SyntaxHighlighter>
          </div>
        </div>
        <div className={styles.placeholderContent}>
          <div className={styles.placeholderText}>SQL Editor loading...</div>
        </div>
      </div>
    );
  }

  if (isProvisioning) {
    return <LoadingSpinner />;
  }

  return (
    <div className={styles.container}>
      {tokenInClipboard && (
        <div className={styles.tokenNotice}>
          Your token is in the clipboard. The connection will be established automatically.
        </div>
      )}

      {connection && <DatabaseDisplay database={database} />}

      <div className={styles.sqlEditor} ref={editorRef}>
        <div className={styles.editorContainer}>
          <SyntaxHighlighter
            language='sql'
            style={sqlTheme}
            customStyle={{ margin: 0, padding: FONT_CONFIG.padding, minHeight: '120px' }}
          >
            {sql}
          </SyntaxHighlighter>

          <textarea
            ref={textareaRef}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            className={styles.textarea}
            style={{
              padding: FONT_CONFIG.padding,
              fontFamily: FONT_CONFIG.fontFamily,
              fontSize: FONT_CONFIG.fontSize,
              lineHeight: FONT_CONFIG.lineHeight,
            }}
            spellCheck='false'
            rows={6}
          />

          <button
            onClick={handleCopy}
            className={`${styles.copyButton} ${copySuccess ? styles.iconButtonSuccess : ''}`}
            title='Copy to clipboard'
            type='button'
          >
            <CopyIcon />
            {copySuccess && <span className={styles.successText}>Copied!</span>}
          </button>

          <button
            onClick={handleFormat}
            className={`${styles.formatButton} ${formatSuccess ? styles.iconButtonSuccess : ''}`}
            title='Format SQL'
            type='button'
          >
            <FormatIcon />
            {formatSuccess && <span className={styles.successText}>Formatted!</span>}
          </button>
        </div>
      </div>

      <div className={styles.buttonContainer}>
        {connection ? (
          <button
            onClick={runQuery}
            disabled={loading}
            className={styles.runButton}
            type='button'
          >
            {loading ? (
              'Running...'
            ) : (
              <>
                <span className={styles.playIcon}><PlayIcon /></span>
                Run SQL
              </>
            )}
          </button>
        ) : (
          <button
            onClick={handleAuth0RedirectLogin}
            disabled={loading || authLoading}
            className={styles.authButton}
            type='button'
          >
            <span className={styles.playIcon}><PlayIcon /></span>
            {loading
              ? 'Connecting...'
              : authLoading
                ? 'Authenticating...'
                : isAuthenticated
                  ? 'Connecting to MotherDuck...'
                  : 'Run with MotherDuck'}
            <span className={styles.duckFeetLogo}><DuckFeetLogo /></span>
          </button>
        )}

        {connection && (
          <button onClick={handleLogout} className={styles.logoutButton} type='button'>
            Logout
          </button>
        )}
      </div>

      {error && <pre className={styles.error}>{error}</pre>}

      {result && result.length > 0 && (
        <div className={styles.results}>
          <SortableTable columns={columns} data={result} />
        </div>
      )}

      {result && result.length === 0 && !error && (
        <div className={styles.noResults}>Query ran successfully, but returned no rows.</div>
      )}
    </div>
  );
};

export default MotherDuckSQLEditor;

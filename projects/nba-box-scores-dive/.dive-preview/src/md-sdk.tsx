/**
 * Simplified @motherduck/react-sql-query shim for local Vite preview.
 * Same API as the production dive runtime — useSQLQuery, useConnection,
 * useConnectionStatus, and MotherDuckSDKProvider.
 */
import { MDConnection } from "@motherduck/wasm-client";
import type { DuckDBRow } from "@motherduck/wasm-client";
import {
  createContext, useContext, useEffect, useMemo, useRef, useState,
  useCallback, useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

// ── Types ──────────────────────────────────────────────────────────

type QueryStatus = "idle" | "loading" | "success" | "error";

type ExportFormat = "csv" | "json" | "parquet" | "xlsx";
type ExportCompression = "none" | "gzip" | "zstd";

export type ExportQueryOptions = {
  format: ExportFormat;
  title?: string;
  filename?: string;
  sheetName?: string;
  copy?: { preserveOrder?: boolean };
  csv?: {
    compression?: ExportCompression;
    dateformat?: string;
    delim?: string;
    escape?: string;
    forceQuote?: readonly string[] | "*";
    header?: boolean;
    nullstr?: string;
    prefix?: string;
    quote?: string;
    suffix?: string;
    timestampformat?: string;
  };
  json?: {
    array?: boolean;
    compression?: ExportCompression;
    dateformat?: string;
    timestampformat?: string;
  };
  parquet?: {
    compression?:
      | "uncompressed"
      | "snappy"
      | "gzip"
      | "zstd"
      | "brotli"
      | "lz4"
      | "lz4_raw";
    compressionLevel?: number;
    fieldIds?: "auto" | Record<string, number | Record<string, number>>;
    kvMetadata?: Record<string, string>;
    parquetVersion?: "v1" | "v2" | "V1" | "V2";
    rowGroupSize?: number;
    rowGroupSizeBytes?: number | string;
    stringDictionaryPageSizeLimit?: number | string;
  };
  xlsx?: {
    header?: boolean;
    sheet?: string;
    sheetRowLimit?: number;
  };
};

type ExportQueryRequest = { sql: string } & ExportQueryOptions;

type ConnectionState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "connected"; connection: MDConnection }
  | { status: "error"; error: Error };

export type UseSQLQueryResult<TData = readonly DuckDBRow[]> = {
  data: TData | undefined;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  isPlaceholderData: boolean;
  error: Error | null;
  refetch: () => void;
  exportAs: (options: ExportQueryOptions) => Promise<void>;
  status: QueryStatus;
};

type UseSQLQueryOptions<TData = readonly DuckDBRow[]> = {
  enabled?: boolean;
  select?: (data: readonly DuckDBRow[]) => TData;
  initialData?: TData;
  placeholderData?: TData | ((prev: TData | undefined) => TData | undefined);
};

async function simulateLocalExport(sql: string, options: ExportQueryOptions) {
  const filename = options.filename || options.title || "export";
  console.info("Dive export requested in local preview", { sql, options });
  window.alert?.(
    `Export requested: ${filename}.${options.format}. Saved MotherDuck dives generate and download the real file.`,
  );
}

// ── QueryObserver (external store for useSyncExternalStore) ────────

interface QueryObserverState {
  status: QueryStatus;
  data: readonly DuckDBRow[] | undefined;
  error: Error | undefined;
  hasHadData: boolean;
  lastData: readonly DuckDBRow[] | undefined;
}

class QueryObserver {
  private state: QueryObserverState = {
    status: "idle", data: undefined, error: undefined,
    hasHadData: false, lastData: undefined,
  };
  private listeners = new Set<() => void>();
  private abortController: AbortController | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.state;
  getStatus() { return this.state.status; }

  private setState(updates: Partial<QueryObserverState>) {
    this.state = { ...this.state, ...updates };
    this.listeners.forEach((l) => l());
  }

  async execute(connection: MDConnection, sql: string) {
    this.abortController?.abort();
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    this.setState({ status: "loading", data: undefined, error: undefined });
    try {
      const result = await connection.safeEvaluateQuery(sql);
      if (signal.aborted) return;
      if (result.status === "error") {
        this.setState({ status: "error", error: result.err, data: undefined });
        return;
      }
      const data = result.result.data.toRows();
      this.setState({
        status: "success", data, error: undefined,
        hasHadData: true, lastData: data,
      });
    } catch (err) {
      if (signal.aborted) return;
      this.setState({
        status: "error",
        error: err instanceof Error ? err : new Error(String(err)),
        data: undefined,
      });
    }
  }

  reset() {
    this.abortController?.abort();
    this.abortController = null;
    this.setState({ status: "idle", data: undefined, error: undefined });
  }
  cancel() {
    this.abortController?.abort();
    this.abortController = null;
  }
}

// ── Provider ───────────────────────────────────────────────────────

type ContextValue = { state: ConnectionState };
const SDKContext = createContext<ContextValue | null>(null);

function useSDKContext() {
  const ctx = useContext(SDKContext);
  if (!ctx) throw new Error("Must be used within MotherDuckSDKProvider");
  return ctx;
}

export function MotherDuckSDKProvider(
  { token, children }: { token: string; children: ReactNode },
) {
  const [state, setState] = useState<ConnectionState>({ status: "idle" });

  useEffect(() => {
    if (!token) { setState({ status: "idle" }); return; }
    let cancelled = false;
    let conn: MDConnection | null = null;
    (async () => {
      setState({ status: "connecting" });
      try {
        conn = MDConnection.create({ mdToken: token, useDuckDBWasmCOI: false });
        await conn.isInitialized();
        if (!cancelled) setState({ status: "connected", connection: conn });
      } catch (err) {
        if (!cancelled) setState({
          status: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    })();
    return () => { cancelled = true; conn?.close(); };
  }, [token]);

  const value = useMemo(() => ({ state }), [state]);
  return <SDKContext.Provider value={value}>{children}</SDKContext.Provider>;
}

// ── useSQLQuery ────────────────────────────────────────────────────

export function useSQLQuery<TData = readonly DuckDBRow[]>(
  sql: string,
  options?: UseSQLQueryOptions<TData>,
): UseSQLQueryResult<TData> {
  const { state: connState } = useSDKContext();
  const observerRef = useRef<QueryObserver | null>(null);
  if (!observerRef.current) observerRef.current = new QueryObserver();
  const observer = observerRef.current;

  const snap = useSyncExternalStore(
    observer.subscribe, observer.getSnapshot, observer.getSnapshot,
  );
  const enabled = options?.enabled !== false;

  useEffect(() => {
    if (!enabled || connState.status !== "connected") {
      if (observer.getStatus() !== "idle") observer.reset();
      return;
    }
    observer.execute(connState.connection, sql);
    return () => observer.cancel();
  }, [sql, enabled, connState, observer]);

  const refetch = useCallback(() => {
    if (connState.status === "connected" && enabled) {
      observer.execute(connState.connection, sql);
    }
  }, [observer, connState, enabled, sql]);

  const exportAs = useCallback(async (exportOptions: ExportQueryOptions) => {
    if (connState.status !== "connected") {
      throw new Error("Cannot export before the MotherDuck connection is ready.");
    }
    await simulateLocalExport(sql, exportOptions);
  }, [connState.status, sql]);

  const isLoading = snap.status === "loading" || connState.status === "connecting";
  const rawData = snap.data ?? snap.lastData;

  const transformed = useMemo(() => {
    if (rawData === undefined) return undefined;
    return options?.select
      ? options.select(rawData)
      : (rawData as unknown as TData);
  }, [rawData, options?.select]);

  const { data, isPlaceholderData } = useMemo(() => {
    if (transformed !== undefined)
      return { data: transformed, isPlaceholderData: false };
    if (!snap.hasHadData && options?.initialData !== undefined)
      return { data: options.initialData, isPlaceholderData: false };
    if (isLoading && options?.placeholderData !== undefined) {
      const ph = typeof options.placeholderData === "function"
        ? (options.placeholderData as (p: TData | undefined) => TData | undefined)(transformed)
        : options.placeholderData;
      if (ph !== undefined) return { data: ph, isPlaceholderData: true };
    }
    return { data: undefined, isPlaceholderData: false };
  }, [transformed, snap.hasHadData, options?.initialData, options?.placeholderData, isLoading]);

  return {
    data, isLoading,
    isSuccess: snap.status === "success",
    isError: snap.status === "error",
    isPlaceholderData,
    error: snap.error ?? null,
    refetch, exportAs, status: snap.status,
  };
}

// ── useDiveState ───────────────────────────────────────────────────

function readBag(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  const m = window.location.hash.match(/state=([^&]+)/);
  if (!m) return {};
  try {
    const json = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function writeBag(bag: Record<string, unknown>) {
  const json = JSON.stringify(bag);
  const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const newHash = `#state=${b64}`;
  if (window.location.hash !== newHash) {
    window.history.replaceState(null, "", newHash);
  }
  window.dispatchEvent(new Event("divestatechange"));
}

export function useDiveState<T>(key: string, initialValue: T): [T, (v: T | ((prev: T) => T)) => void] {
  const subscribe = useCallback((cb: () => void) => {
    window.addEventListener("divestatechange", cb);
    window.addEventListener("hashchange", cb);
    return () => {
      window.removeEventListener("divestatechange", cb);
      window.removeEventListener("hashchange", cb);
    };
  }, []);
  const getSnapshot = useCallback(() => {
    const bag = readBag();
    return key in bag ? JSON.stringify(bag[key]) : undefined;
  }, [key]);
  const raw = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const value = useMemo<T>(() => {
    if (raw === undefined) return initialValue;
    try { return JSON.parse(raw) as T; } catch { return initialValue; }
  }, [raw, initialValue]);

  const setValue = useCallback((next: T | ((prev: T) => T)) => {
    const bag = readBag();
    const prev = key in bag ? (bag[key] as T) : initialValue;
    const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
    if (resolved === undefined) delete bag[key];
    else bag[key] = resolved;
    writeBag(bag);
  }, [key, initialValue]);

  return [value, setValue];
}

// ── useConnection / useConnectionStatus ────────────────────────────

export function useConnection(): MDConnection | null {
  const { state } = useSDKContext();
  return state.status === "connected" ? state.connection : null;
}

export function useConnectionStatus() {
  const { state } = useSDKContext();
  return {
    isConnected: state.status === "connected",
    isConnecting: state.status === "connecting",
    error: state.status === "error" ? state.error : null,
  };
}

export function useExport() {
  const { state } = useSDKContext();
  const exportQuery = useCallback(async ({ sql, ...options }: ExportQueryRequest) => {
    if (state.status !== "connected") {
      throw new Error("Cannot export before the MotherDuck connection is ready.");
    }
    await simulateLocalExport(sql, options);
  }, [state.status]);

  return { exportQuery };
}

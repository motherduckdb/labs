// Stand-in for @motherduck/react-sql-query: hands back the rows the test harness already
// fetched from MotherDuck for exactly this SQL text, and logs every SQL text the Dive asked
// for (so a test can prove which SQL a control change produced).
import { useState } from "react";

export function useSQLQuery(sql) {
  const log = (globalThis.__DIVE_SQL_LOG__ ||= []); // every distinct SQL text, in first-seen order
  if (!log.includes(sql)) log.push(sql);
  const rows = globalThis.__DIVE_ROWS__[sql];
  if (rows === undefined) return { data: undefined, isLoading: false, isError: true, error: new Error("harness has no rows for SQL: " + sql.slice(0, 80)) };
  return { data: rows, isLoading: false, isError: false, error: null };
}

// Like useState, plus a registry the runners read back (what the Dive would persist).
export function useDiveState(key, initial) {
  const store = (globalThis.__DIVE_STATE__ ||= {});
  const [value, setValue] = useState(key in store ? store[key] : initial);
  store[key] = value;
  return [value, (v) => { store[key] = v; setValue(v); }];
}
export function useExport() { return { exportQuery: async () => {} }; }

export interface SqlRow {
  [key: string]: any;
}

export interface MotherDuckSQLEditorProps {
  /** Initial SQL query shown in the editor. */
  query?: string;
  /** Whether to auto-format the initial query with sql-formatter. Default: true. */
  formatOnLoad?: boolean;
  /** Database the editor should connect to (e.g. 'sample_data', 'my_db'). */
  database: string;
  /** Optional workspace scope. */
  workspace?: string;
  /**
   * Light/dark theme for the syntax highlighter. If omitted, follows
   * `prefers-color-scheme`.
   */
  colorMode?: 'light' | 'dark';
  /**
   * Optional pre-provisioning behavior. If provided, the editor will ensure
   * the named database exists (or is attached) before connecting.
   * - `mode: 'create-empty'` runs `CREATE DATABASE <database>` if missing.
   * - `mode: 'attach-share'` runs `ATTACH '<shareUrl>' AS <database>` if missing,
   *   trying each URL in `shareUrls` until one succeeds (useful for region-specific
   *   shared databases).
   */
  provisioning?:
    | { mode: 'create-empty' }
    | { mode: 'attach-share'; shareUrls: string[] };
}

export interface SecurityValidationResult {
  isValid: boolean;
  error?: string;
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSessionId } from '@/lib/session-id';
import type { SchemaTable, SchemaColumn } from '@/lib/mcp-parsers';

export function SchemaExplorerSidebar({ database }: { database: string }) {
  const [tables, setTables] = useState<SchemaTable[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [columns, setColumns] = useState<SchemaColumn[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/schema?database=${encodeURIComponent(database)}`, {
      headers: { 'x-session-id': getSessionId() },
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Failed to load schema');
        setTables(data.tables || []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load schema'));
  }, [database]);

  const loadColumns = useCallback((table: string) => {
    setSelected(table);
    fetch(`/api/schema?database=${encodeURIComponent(database)}&table=${encodeURIComponent(table)}`, {
      headers: { 'x-session-id': getSessionId() },
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Failed to load columns');
        setColumns(data.columns || []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load columns'));
  }, [database]);

  return (
    <aside className="schema-panel">
      <h2>Schema</h2>
      <p>{database}</p>
      {error && <p className="error">{error}</p>}
      <div className="schema-grid">
        <div>
          {tables.map((table) => (
            <button
              className={selected === table.name ? 'table-row selected' : 'table-row'}
              key={`${table.schema}.${table.name}`}
              onClick={() => loadColumns(table.name)}
            >
              {table.schema}.{table.name}
            </button>
          ))}
        </div>
        <div>
          {selected ? (
            columns.map((column) => (
              <div className="column-row" key={column.name}>
                <strong>{column.name}</strong>
                <span>{column.type}</span>
                {column.comment && <p>{column.comment}</p>}
              </div>
            ))
          ) : (
            <p>Pick a table to inspect columns.</p>
          )}
        </div>
      </div>
    </aside>
  );
}

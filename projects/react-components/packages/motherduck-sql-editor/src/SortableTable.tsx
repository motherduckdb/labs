import { CSSProperties, useState } from 'react';
import {
  flexRender,
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
} from '@tanstack/react-table';

const headerCellStyle: CSSProperties = {
  padding: '6px 8px',
  fontSize: '0.85em',
  fontWeight: 'bold',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  borderBottom: '2px solid #d7d7d7',
  color: '#1c1e21',
  cursor: 'pointer',
  backgroundColor: '#f0f0f0',
};

const cellStyle: CSSProperties = {
  padding: '4px 8px',
  fontSize: '0.85em',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  borderBottom: '1px solid #e6e6e6',
  color: '#1c1e21',
  maxWidth: '250px',
};

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  tableLayout: 'fixed',
  backgroundColor: '#ffffff',
};

const showMoreButtonStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '6px',
  marginTop: '8px',
  backgroundColor: '#e6e6e6',
  border: '1px solid #d7d7d7',
  borderRadius: '4px',
  textAlign: 'center',
  cursor: 'pointer',
  fontSize: '0.85em',
  color: '#525860',
};

export interface SortableTableProps {
  columns: any[];
  data: any[];
  sortBy?: SortingState;
  initialRowsToShow?: number;
}

export default function SortableTable({ columns, data, sortBy = [], initialRowsToShow = 15 }: SortableTableProps) {
  const [visibleRows, setVisibleRows] = useState(initialRowsToShow);

  const table = useReactTable({
    columns,
    data,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    initialState: { sorting: sortBy },
  });

  const rows = table.getRowModel().rows.slice(0, visibleRows);
  const hasMoreRows = visibleRows < table.getRowModel().rows.length;

  return (
    <>
      <table role='table' style={tableStyle}>
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id} role='row'>
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  colSpan={header.colSpan}
                  role='columnheader'
                  style={headerCellStyle}
                  onClick={header.column.getToggleSortingHandler()}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  <span style={{ fontSize: '0.8em', marginLeft: '3px' }}>
                    {({ asc: ' ▲', desc: ' ▼' } as Record<string, string>)[header.column.getIsSorted() as string] ?? ''}
                  </span>
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody role='rowgroup'>
          {rows.map((row, rowIndex) => (
            <tr
              key={row.id}
              role='row'
              style={{ backgroundColor: rowIndex % 2 === 0 ? '#ffffff' : '#f5f5f5' }}
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} role='cell' style={cellStyle}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {hasMoreRows && (
        <button
          style={showMoreButtonStyle}
          onClick={() => setVisibleRows(Math.min(visibleRows + 15, table.getRowModel().rows.length))}
        >
          Show more rows ({visibleRows} of {table.getRowModel().rows.length} shown)
        </button>
      )}
    </>
  );
}

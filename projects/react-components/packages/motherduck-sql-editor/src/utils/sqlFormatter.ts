import { format } from 'sql-formatter';

export const formatSql = (sql: string): string => {
  try {
    if (sql.includes("read_csv_auto(['") || sql.includes("read_parquet('")) {
      return sql;
    }
    return format(sql, {
      language: 'sql',
      keywordCase: 'upper',
      indentStyle: 'standard',
    });
  } catch (error) {
    console.error('Error formatting SQL:', error);
    return sql;
  }
};

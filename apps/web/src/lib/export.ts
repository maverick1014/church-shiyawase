/**
 * Client-side Excel (.xlsx) export helpers. `xlsx` (SheetJS) is loaded lazily
 * on first use so it never weighs down the initial page bundle.
 */

import { churchDateKey } from './time';

function colWidths(
  headers: string[],
  cellLen: (h: string, i: number) => number,
): { wch: number }[] {
  return headers.map((h, i) => ({
    wch: Math.min(40, Math.max(6, Math.ceil(Math.max(h.length * 2, cellLen(h, i))))),
  }));
}

function download(wb: unknown, XLSX: typeof import('xlsx'), name: string): void {
  const stamp = churchDateKey();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  XLSX.writeFile(wb as any, `${name}_${stamp}.xlsx`);
}

/** Export an array of row objects; keys become the header row. */
export async function exportRows(
  filename: string,
  sheetName: string,
  rows: Record<string, string | number>[],
): Promise<void> {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.json_to_sheet(rows);
  const keys = rows.length ? Object.keys(rows[0]) : [];
  ws['!cols'] = colWidths(keys, (k) =>
    Math.max(0, ...rows.map((r) => String(r[k] ?? '').length * 1.6)),
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  download(wb, XLSX, filename);
}

/** Export an explicit header row + matrix (for dynamic-column grids). */
export async function exportMatrix(
  filename: string,
  sheetName: string,
  headers: string[],
  matrix: (string | number)[][],
): Promise<void> {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([headers, ...matrix]);
  ws['!cols'] = colWidths(headers, (_h, i) =>
    Math.max(0, ...matrix.map((r) => String(r[i] ?? '').length * 1.6)),
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  download(wb, XLSX, filename);
}

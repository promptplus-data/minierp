/**
 * File reading for imports (M04 Import Hub and the delivery-file import, docs/integrations/onprem-delivery-file.md §1):
 * CSV in UTF-8 / UTF-8 with BOM / TIS-620 (auto-detected), delimiter `,` `;` or tab, RFC 4180 quotes (papaparse);
 * XLSX first sheet (read-excel-file). Header = first non-empty line not starting with '#'.
 */
import { createHash } from 'node:crypto';
import Papa from 'papaparse';
import { readSheet } from 'read-excel-file/node';
import { normHeader, type Cell } from '@erp/core';
import { E } from '../../lib/errors';

export interface ParsedFile {
  headers: string[];
  /** Data rows (after the header), each padded to the header length. rowNo is the 1-based line in the file. */
  rows: { rowNo: number; cells: Cell[] }[];
  encoding: 'utf8' | 'tis620' | 'xlsx';
  delimiter: string | null;
  sha256: string;
  /** SHA-256 of the normalised header names (profile key). */
  signature: string;
}

export interface FileLimits { maxBytes: number; maxRows: number }

const isXlsx = (name: string, buf: Buffer) => /\.xlsx$/i.test(name) || (buf[0] === 0x50 && buf[1] === 0x4b);

export function decodeText(buf: Buffer, encoding: 'auto' | 'utf8' | 'tis620'): { text: string; encoding: 'utf8' | 'tis620' } {
  if (encoding === 'tis620') return { text: new TextDecoder('windows-874').decode(buf), encoding: 'tis620' };
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (bom) return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf8' };
  if (encoding === 'utf8') return { text: new TextDecoder('utf-8').decode(buf), encoding: 'utf8' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf8' };
  } catch {
    return { text: new TextDecoder('windows-874').decode(buf), encoding: 'tis620' };
  }
}

const blank = (cells: Cell[]) => cells.every((c) => c == null || (typeof c === 'string' && c.trim() === ''));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const headerSignature = (headers: string[]) => sha(headers.map(normHeader).join('\u0001'));

function pickDelimiter(headerLine: string): string {
  const counts = [',', ';', '\t'].map((c) => [c, headerLine.split(c).length - 1] as const);
  const best = counts.sort((a, b) => b[1] - a[1])[0]!;
  return best[1] > 0 ? best[0] : ',';
}

/** Parses an uploaded file. Throws VALIDATION for unreadable files or files over the limits. */
export async function parseFile(fileName: string, contentBase64: string, encoding: 'auto' | 'utf8' | 'tis620', limits: FileLimits): Promise<ParsedFile> {
  const buf = Buffer.from(contentBase64, 'base64');
  if (!buf.length) throw E.validation('ไฟล์ว่าง');
  if (buf.length > limits.maxBytes) throw E.validation(`ไฟล์ใหญ่เกิน ${Math.round(limits.maxBytes / 1024 / 1024)} MB`);
  if (!/\.(csv|txt|xlsx)$/i.test(fileName)) throw E.validation('รองรับเฉพาะไฟล์ .csv หรือ .xlsx');
  let grid: Cell[][];
  let enc: ParsedFile['encoding'];
  let delimiter: string | null = null;
  if (isXlsx(fileName, buf)) {
    try {
      grid = (await readSheet(buf)) as Cell[][];
    } catch {
      throw E.validation('อ่านไฟล์ Excel ไม่ได้ (รองรับ .xlsx)');
    }
    enc = 'xlsx';
  } else {
    const dec = decodeText(buf, encoding);
    enc = dec.encoding;
    const lines = dec.text.split(/\r\n|\n|\r/);
    const headerIdx = lines.findIndex((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    if (headerIdx < 0) throw E.validation('ไม่พบหัวตารางในไฟล์');
    delimiter = pickDelimiter(lines[headerIdx]!);
    // Keep the original line numbers: blank out the skipped preamble instead of dropping it.
    const body = lines.map((l, i) => (i < headerIdx ? '' : l)).join('\n');
    const res = Papa.parse<string[]>(body, { delimiter, skipEmptyLines: false });
    grid = res.data.map((r) => r.map((c) => c));
  }
  const headerRow = grid.findIndex((r) => !blank(r) && !(typeof r[0] === 'string' && r[0].trim().startsWith('#')));
  if (headerRow < 0) throw E.validation('ไม่พบหัวตารางในไฟล์');
  const headers = grid[headerRow]!.map((c) => (c == null ? '' : String(c).trim()));
  while (headers.length && headers[headers.length - 1] === '') headers.pop();
  if (!headers.length) throw E.validation('ไม่พบหัวตารางในไฟล์');
  const rows: ParsedFile['rows'] = [];
  for (let i = headerRow + 1; i < grid.length; i++) {
    const r = grid[i]!;
    if (blank(r)) continue;
    const cells = headers.map((_, j) => (r[j] === undefined ? null : r[j]!));
    rows.push({ rowNo: i + 1, cells });
  }
  if (rows.length > limits.maxRows) throw E.validation(`ไฟล์มี ${rows.length} บรรทัด เกินกำหนด ${limits.maxRows} บรรทัด`);
  return { headers, rows, encoding: enc, delimiter, sha256: sha(buf), signature: headerSignature(headers) };
}

/** Display text of a cell for previews / error files. */
export const cellText = (c: Cell): string => (c == null ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c));

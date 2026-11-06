import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { safeCents } from './query.js';
import { financeError } from './core.js';

export type ExportRow = Record<string, unknown>;
type Value = string | number | null;
export type Column = { title: string; width: number; money?: boolean };
export const column = (title: string, width = 18): Column => ({ title, width });
export const moneyColumn = (title: string): Column => ({ ...column(title), money: true });
export const textCell = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';
export function cents(value: unknown) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    financeError('导出金额超出可精确处理的范围。');
  return value;
}
export const totalCents = <T>(rows: readonly T[], value: (row: T) => unknown) =>
  safeCents(rows.reduce((sum, row) => sum + BigInt(cents(value(row)) ?? 0), 0n));

const shade = (argb: string): ExcelJS.Fill => ({
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb },
});

export class ExportSheet {
  constructor(
    private sheet: ExcelJS.Worksheet,
    title: string,
    scope: string,
    review = false,
  ) {
    sheet.addRow([title]).font = { bold: true, size: 16, color: { argb: 'FF203446' } };
    sheet.getRow(1).height = 25;
    sheet.addRow([scope + '　单位：元']);
    if (review) this.note('报表项目和公式待财务复核，仅供内部参考');
  }

  note(value: string) {
    this.sheet.addRow([value]).font = { bold: true, color: { argb: 'FF44546A' } };
  }

  table(
    columns: readonly Column[],
    rows: readonly (readonly Value[])[],
    footer?: readonly Value[],
    section?: string,
  ) {
    const first = !this.sheet.views.length;
    if (section && !first) {
      this.sheet.addRow([]);
      this.note(section);
    }
    columns.forEach(({ width }, index) => {
      const col = this.sheet.getColumn(index + 1);
      col.width = Math.max(col.width ?? 0, width);
    });
    const header = this.sheet.addRow(columns.map((col) => col.title));
    header.height = 22;
    header.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = shade('FF344C60');
    });
    if (first) {
      this.sheet.views = [{ state: 'frozen', ySplit: header.number }];
      if (section) this.note(section);
    }
    const add = (values: readonly Value[], total = false) => {
      const row = this.sheet.addRow([]);
      let lines = 1;
      columns.forEach((col, index) => {
        const value = values[index];
        const cell = row.getCell(index + 1);
        // 业务文字以 Excel 字符串写入，只有显示金额使用数值类型。
        cell.value = col.money && typeof value === 'number' ? value / 100 : (value ?? null);
        if (col.money) cell.numFmt = '#,##0.00';
        if (typeof value === 'string') {
          const width = this.sheet.getColumn(index + 1).width ?? col.width;
          const wrapped = value.split(/\r?\n/).reduce((count, line) => {
            const characters = line.length + (line.match(/[^\x00-\x7f]/g)?.length ?? 0);
            return count + Math.max(1, Math.ceil(characters / Math.max(1, width - 2)));
          }, 0);
          if (wrapped > 1) {
            cell.alignment = { wrapText: true, vertical: 'middle' };
            lines = Math.max(lines, wrapped);
          }
        }
        if (total) {
          cell.font = { bold: true };
          cell.fill = shade('FFE9EFF4');
        }
      });
      if (lines > 1) row.height = Math.min(409, lines * 15);
    };
    rows.forEach((row) => add(row));
    if (footer) add(footer, true);
  }
}

export const workbookBytes = async (book: ExcelJS.Workbook) =>
  Buffer.from(await book.xlsx.writeBuffer());
export async function singleSheet(
  title: string,
  scope: string,
  build: (sheet: ExportSheet) => void,
) {
  const book = new ExcelJS.Workbook();
  build(new ExportSheet(book.addWorksheet(title), title, scope));
  return workbookBytes(book);
}

export function financeAttachment(
  res: Response,
  title: string,
  extension: 'xlsx' | 'zip',
  bytes: Buffer,
) {
  const filename = title + '.' + extension;
  return res
    .type(extension)
    .set(
      'Content-Disposition',
      `attachment; filename="finance.${extension}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    )
    .send(bytes);
}

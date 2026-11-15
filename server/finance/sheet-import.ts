import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { validateOffice } from '../core/index.js';
import { CENTS_PER_YUAN, MIB } from '../../shared/core/index.js';
import { financeError } from './core.js';
import { safeCents } from './amounts.js';
import { utcDay } from './days.js';

/** 导入的表格最多多大（MB） */
const SHEET_MAX_MB = 10;
/** 导入的表格最多几行、几列（导入时按列号选哪一列是什么，列号也不超过这个数） */
export const SHEET_MAX_ROWS = 10000;
export const SHEET_MAX_COLUMNS = 200;
/** 角分最多两位 */
const CENT_DIGITS = 2;

/** 导入表格（银行流水、工资表）：单元格里的金额文字转成分，最多两位小数，不经过浮点。 */
export function yuan(value: string) {
  const match = /^([+-]?)(\d{1,16})(?:\.(\d{1,2}))?$/.exec(value.trim().replaceAll(',', ''));
  if (!match) financeError('金额须明确填写，最多两位小数。');
  const cents = BigInt(match[2]) * CENTS_PER_YUAN + BigInt((match[3] ?? '').padEnd(CENT_DIGITS, '0'));
  return safeCents(match[1] === '-' ? -cents : cents);
}

/** 读进表格：CSV 只收 UTF-8 文本，xlsx 先按办公文件核对 */
async function readWorkbook(bytes: Buffer, format: 'csv' | 'xlsx') {
  const w = new ExcelJS.Workbook();
  if (format === 'csv') {
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      financeError('CSV 须为 UTF-8 编码。');
    }
    if (source.includes('\0')) financeError('CSV 包含非文本内容。');
    // 单元格原样当文字读，不让 exceljs 猜成数字、日期
    await w.csv.read(Readable.from([source]), { map: (value: unknown) => value });
  } else {
    await validateOffice(bytes, 'xlsx');
    // 走流：exceljs 的 load 声明要它自己的 Buffer 类型（和 Node 的对不上），read 收流后照样交给 load
    await w.xlsx.read(Readable.from([bytes]));
  }
  return w;
}

export async function sheetRows(bytes: Buffer, format: 'csv' | 'xlsx', skip: number) {
  if (bytes.length > SHEET_MAX_MB * MIB) financeError('表格超过 ' + SHEET_MAX_MB + ' MB。');
  const sheet = (await readWorkbook(bytes, format)).worksheets[0];
  if (!sheet || sheet.rowCount > SHEET_MAX_ROWS || sheet.columnCount > SHEET_MAX_COLUMNS)
    financeError('文件为空或超过 ' + SHEET_MAX_ROWS + ' 行、' + SHEET_MAX_COLUMNS + ' 列限制。');
  const rows: string[][] = [];
  sheet.eachRow((row, i) => {
    if (i <= skip) return;
    rows.push(
      Array.from({ length: sheet.columnCount }, (_, j) => {
        const value = row.getCell(j + 1).value;
        if (value instanceof Date) return utcDay(value);
        if (typeof value === 'object' && value !== null)
          financeError('导入只接受普通文本、日期和数值单元格。');
        return value == null ? '' : String(value);
      }),
    );
  });
  return rows;
}

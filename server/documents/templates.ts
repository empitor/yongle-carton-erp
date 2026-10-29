import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  HeadingLevel,
  BorderStyle,
  Header,
  Footer,
  PageNumber,
} from 'docx';
import ExcelJS from 'exceljs';
import { factoryName } from '../../shared/business-export.js';
import {
  templateHeaderText,
  documentColumns,
  purchaseColumns,
  deliveryColumns,
  type DocumentTemplate,
  type DocumentColumn,
} from '../../shared/document-templates.js';
export type BusinessForm = {
  title: string;
  companyName?: string;
  color?: string;
  fontSize?: number;
  templateId?: string;
  templateRevision?: number;
  defaultFormat?: 'docx' | 'xlsx';
  kind?: 'purchase' | 'delivery';
  headerText?: string;
  footerText?: string;
  fontFamily?: string;
  orientation?: 'portrait' | 'landscape';
  density?: 'compact' | 'normal';
  columnKeys?: DocumentColumn[];
  lineData?: Record<string, string>[];
  templateSnapshot?: DocumentTemplate;
  number: string;
  draft: boolean;
  sample?: boolean;
  fields: [string, string][];
  headers: string[];
  rows: string[][];
  notes: string;
  total?: string | null;
  signatures: string[];
};
export function applyDocumentTemplate(
  form: BusinessForm,
  template: DocumentTemplate,
  revision = 0,
): BusinessForm {
  const keys =
    template.columns || (template.kind === 'purchase' ? purchaseColumns : deliveryColumns);
  const originalKeys =
    form.columnKeys || (template.kind === 'purchase' ? purchaseColumns : deliveryColumns);
  const fields: [string, string][] = [...form.fields];
  if (template.companyContact || template.companyPhone)
    fields.push([
      '我方联系人',
      [template.companyContact, template.companyPhone].filter(Boolean).join(' / '),
    ]);
  if (template.kind === 'delivery' && template.companyAddress)
    fields.push(['我方地址', template.companyAddress]);
  if (template.kind === 'purchase') {
    if (template.companyAddress) fields.push(['交货地址', template.companyAddress]);
    if (template.deliveryTerms) fields.push(['交货要求', template.deliveryTerms]);
    if (template.acceptanceTerms) fields.push(['验收要求', template.acceptanceTerms]);
    if (template.paymentTerms) fields.push(['付款条件', template.paymentTerms]);
    fields.push(['税费说明', '本单未记录独立税费约定；如有约定，以本单备注为准，不自动推算税额。']);
  }
  return {
    ...form,
    kind: template.kind,
    companyName: template.companyName,
    title: template.title + (form.title.includes('已取消') ? '（已取消，仅供存档）' : ''),
    fields: fields.filter(([k]) => !template.hiddenFields.includes(k as any)),
    headers: keys.map((k) =>
      k === 'quantity'
        ? template.kind === 'purchase'
          ? '订购数量'
          : '本批送货数量'
        : documentColumns[k],
    ),
    rows: form.rows.map((r, i) => {
      const data = {
        ...Object.fromEntries(originalKeys.map((k, j) => [k, r[j]])),
        ...form.lineData?.[i],
      };
      return keys.map((k) => data[k] || '');
    }),
    columnKeys: keys,
    signatures: template.signatures,
    notes: [form.notes, template.footerNotes].filter(Boolean).join('\n'),
    color: template.color,
    fontSize: template.fontSize,
    fontFamily: template.fontFamily,
    orientation: template.orientation,
    density: template.density,
    headerText: template.headerText,
    footerText: template.footerText,
    templateId: template.id,
    templateRevision: revision,
    defaultFormat: template.defaultFormat,
    templateSnapshot: template,
  };
}
export async function renderBusinessForm(
  form: BusinessForm,
  format: 'docx' | 'xlsx',
): Promise<Buffer> {
  const company = form.companyName || factoryName,
    size = form.fontSize || 10,
    color = form.color || 'E8EEF0',
    font = form.fontFamily || '宋体',
    orientation = form.orientation || 'landscape',
    contentWidth = orientation === 'landscape' ? 15338 : 10406,
    weights = form.headers.map(
      (_, i) =>
        (
          ({
            index: 0.6,
            name: 2.1,
            specification: 3.3,
            unit: 0.8,
            quantity: 1.3,
            unitPrice: 1.8,
            amount: 1.6,
            notes: 2.2,
            productCode: 1.8,
            orderNumber: 1.8,
            customerOrderNumber: 1.8,
          }) as Record<string, number>
        )[form.columnKeys?.[i] || ''] || 1.5,
    ),
    widths = weights.map((w) =>
      Math.floor((contentWidth * w) / weights.reduce((n, v) => n + v, 0)),
    );
  const draftLabel = form.sample ? ' 测试样张 非正式' : form.draft ? ' 计划单 非正式' : '';
  const title = company + ' ' + form.title + draftLabel;
  if (format === 'docx') {
    const p = (text: string, bold = false, textColor = '111111') =>
      new Paragraph({
        spacing: { after: form.density === 'compact' ? 55 : 100 },
        children: [new TextRun({ text, bold, color: textColor, size: size * 2, font })],
      });
    const cell = (text: string, header = false) =>
      new TableCell({
        shading: header ? { fill: color } : undefined,
        margins: {
          top: form.density === 'compact' ? 65 : 110,
          bottom: form.density === 'compact' ? 65 : 110,
          left: 80,
          right: 80,
        },
        children: [p(text, header, header ? templateHeaderText(color) : '111111')],
      });
    const table = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: 'fixed',
      columnWidths: widths,
      borders: Object.fromEntries(
        ['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical'].map((x) => [
          x,
          { style: BorderStyle.SINGLE, size: 4, color: '869496' },
        ]),
      ),
      rows: [
        new TableRow({ tableHeader: true, children: form.headers.map((h) => cell(h, true)) }),
        ...form.rows.map((r) => new TableRow({ cantSplit: true, children: r.map((v) => cell(v)) })),
      ],
    });
    return Packer.toBuffer(
      new Document({
        creator: company,
        title,
        styles: {
          paragraphStyles: [
            {
              id: 'Title',
              name: 'Title',
              basedOn: 'Normal',
              run: { color: '000000', font, size: 36, bold: true },
            },
          ],
          default: {
            document: {
              run: { font, size: size * 2 },
              paragraph: { spacing: { after: 100 } },
            },
          },
        },
        sections: [
          {
            properties: {
              page: {
                size: { orientation, width: 11906, height: 16838 },
                margin: { top: 750, bottom: 750, left: 750, right: 750 },
              },
            },
            headers: { default: new Header({ children: [p(form.headerText || '')] }) },
            footers: {
              default: new Footer({
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                      new TextRun({ text: (form.footerText || '') + '　 第 ', font, size: 18 }),
                      new TextRun({ children: [PageNumber.CURRENT], font, size: 18 }),
                      new TextRun({ text: ' 页', font, size: 18 }),
                    ],
                  }),
                ],
              }),
            },
            children: [
              new Paragraph({
                text: company,
                alignment: AlignmentType.CENTER,
                spacing: { after: 140 },
              }),
              new Paragraph({
                text: form.title + draftLabel,
                heading: HeadingLevel.TITLE,
                alignment: AlignmentType.CENTER,
                spacing: { after: 200 },
              }),
              new Table({
                width: { size: 100, type: WidthType.PERCENTAGE },
                columnWidths: [Math.floor(contentWidth / 2), Math.floor(contentWidth / 2)],
                borders: Object.fromEntries(
                  ['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical'].map(
                    (x) => [x, { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }],
                  ),
                ),
                rows: Array.from(
                  { length: Math.ceil(form.fields.length / 2) },
                  (_, i) =>
                    new TableRow({
                      children: [0, 1].map(
                        (j) =>
                          new TableCell({
                            margins: { top: 70, bottom: 70, left: 0, right: 140 },
                            children: [
                              p(
                                form.fields[i * 2 + j]
                                  ? form.fields[i * 2 + j][0] +
                                      '：' +
                                      (form.fields[i * 2 + j][1] || '未填写')
                                  : '',
                              ),
                            ],
                          }),
                      ),
                    }),
                ),
              }),
              p(''),
              table,
              ...(form.total !== undefined
                ? [p('合计金额（元）：' + (form.total ?? '待核价'), true)]
                : []),
              p('备注：' + (form.notes || '无')),
              p(form.signatures.join('________________    ') + '________________'),
            ],
          },
        ],
      }),
    );
  }
  const book = new ExcelJS.Workbook();
  book.creator = company;
  const sheet = book.addWorksheet(
    form.kind === 'purchase' || form.templateId === 'purchase-default'
      ? '采购订货单'
      : form.kind === 'delivery' || form.templateId === 'delivery-default'
        ? '送货单'
        : form.title,
    {
      views: [
        {
          state: 'frozen',
          ySplit: Math.ceil(form.fields.length / 2) + 2 + (form.headerText ? 1 : 0),
        },
      ],
      pageSetup: {
        paperSize: 9,
        orientation,
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        horizontalCentered: true,
        margins: { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.1, footer: 0.1 },
      },
    },
  );
  const cols = form.headers.length;
  const merged = (text: string, height = 24) => {
    const n = sheet.rowCount + 1;
    sheet.mergeCells(n, 1, n, cols);
    sheet.getCell(n, 1).value = text;
    sheet.getRow(n).height = height;
    return sheet.getCell(n, 1);
  };
  const heading = merged(title, 36);
  heading.font = { name: font, size: 18, bold: true };
  heading.alignment = { horizontal: 'center', vertical: 'middle' };
  if (form.headerText) merged(form.headerText);
  const split = Math.floor(cols / 2);
  for (let i = 0; i < form.fields.length; i += 2) {
    if (cols < 4) {
      for (const [k, v] of form.fields.slice(i, i + 2)) merged(k + '：' + (v || '未填写'));
      continue;
    }
    const n = sheet.rowCount + 1;
    sheet.mergeCells(n, 1, n, split);
    sheet.mergeCells(n, split + 1, n, cols);
    [1, split + 1].forEach((col, j) => {
      const f = form.fields[i + j];
      sheet.getCell(n, col).value = f ? f[0] + '：' + (f[1] || '未填写') : '';
    });
    sheet.getRow(n).height = Math.max(
      25,
      ...form.fields
        .slice(i, i + 2)
        .map(
          ([k, v]) =>
            Math.ceil((k.length + v.length) / (orientation === 'landscape' ? 50 : 30)) * 16,
        ),
    );
  }
  const header = sheet.addRow(form.headers);
  header.font = {
    name: font,
    bold: true,
    size,
    color: { argb: 'FF' + templateHeaderText(color) },
  };
  header.height = 28;
  header.eachCell(
    (c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + color } }),
  );
  for (const values of form.rows) {
    const row = sheet.addRow(
      values.map((v, i) => {
        // Excel只有15位有效数；超出时按文本保留完整原数值，避免悄悄截断。
        if (
          (!form.columnKeys || ['index', 'quantity', 'amount'].includes(form.columnKeys[i])) &&
          /^\d+(\.\d+)?$/.test(v) &&
          v.replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length <= 15 &&
          Number(v).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) ===
            v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
        )
          return Number(v);
        return v;
      }),
    );
    row.height = Math.max(
      38,
      ...values.map((v, i) => Math.ceil(v.length / (i === 1 || i === 2 ? 22 : 12)) * 15),
    );
    row.eachCell({ includeEmpty: true }, (c) => {
      c.numFmt =
        typeof c.value === 'number' && !Number.isInteger(c.value)
          ? '0.' + '0'.repeat(String(c.value).split('.')[1]?.length || 0)
          : '0';
    });
  }
  const lastData = sheet.rowCount;
  for (let r = header.number; r <= lastData; r++)
    sheet.getRow(r).eachCell({ includeEmpty: true }, (c) => {
      c.border = Object.fromEntries(
        ['top', 'bottom', 'left', 'right'].map((x) => [
          x,
          { style: 'thin', color: { argb: 'FF869496' } },
        ]),
      );
      c.alignment = { vertical: 'middle', wrapText: true };
    });
  if (form.total !== undefined) {
    const c = merged('合计金额（元）：' + (form.total ?? '待核价'));
    c.font = { bold: true, name: font, size: 11 };
  }
  merged('备注：' + (form.notes || '无'), Math.max(30, Math.ceil(form.notes.length / 85) * 18));
  merged(form.signatures.join('________________    ') + '________________', 35);
  sheet.columns.forEach((c, i) => (c.width = Math.max(7, widths[i] / 90)));
  sheet.eachRow((r) =>
    r.eachCell((c) => {
      c.font = { name: font, size, ...c.font };
      c.alignment = { wrapText: true, vertical: 'middle', ...c.alignment };
    }),
  );
  sheet.pageSetup.printTitlesRow = `1:${header.number}`;
  sheet.pageSetup.printArea = `A1:${sheet.getColumn(cols).letter}${sheet.rowCount}`;
  sheet.headerFooter.oddFooter =
    '&L' + (form.footerText || '').replaceAll('&', '&&') + '&R第 &P 页 / 共 &N 页';
  return Buffer.from(await book.xlsx.writeBuffer());
}

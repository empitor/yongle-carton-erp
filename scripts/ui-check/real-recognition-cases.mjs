// 识别前后对比用的虚构文件和“标准答案”（real-recognition.mjs）。全是测试数据，当场生成。
// 答案按原件写：原件没写的栏是 null；一栏可以有几种算对的写法时给数组（比如原件只有行交期时，行上空着或照抄整单交期都算对）。
// 订单的整单交期：原件没写时由代码取最晚的行交期，所以答案写最晚行交期。
import { createRequire } from 'node:module';
import { FILES, pdfWithImage, textImage } from './real-suite-files.mjs';

const require = createRequire(new URL('../../package.json', import.meta.url));
/** 一行标准答案：size 是 [长, 宽, 高]；notes 不写算 null；别的栏照写（会盖掉前面的默认值） */
const line = ({ code, size: [length, width, height], notes = null, ...fields }) =>
  ({ productCode: code, length, width, height, unit: '只', notes, ...fields });
async function xlsx(name, rows) {
  const ExcelJS = require('exceljs');
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Sheet1');
  for (const r of rows) sheet.addRow(r);
  return { name, bytes: Buffer.from(await book.xlsx.writeBuffer()) };
}
async function imagePdf(name, lines, ascii = []) {
  const img = await textImage(lines, { format: 'jpeg', width: 1100, size: 24 });
  return { name, bytes: pdfWithImage(img.bytes, img.width, img.height, ascii) };
}

export const CASES = [
  {
    id: 'O1', kind: 'order', title: 'Excel 两行，带订单日期和整单交期',
    file: () => FILES.orderXlsx(),
    header: { buyerName: '虚构东海电器有限公司', purchaseOrderNumber: 'PO-XG-7731', orderDate: '2026-11-14', deliveryDate: '2026-12-08', taxRate: null, taxMode: null },
    lines: [line({ productName: '电饭煲外箱 3L', code: null, size: ['420', '320', '300'], material: null, flute: null, quantity: '600', unitPrice: '1.35', deliveryDate: '2026-12-01' }), line({ productName: '水壶外箱', code: null, size: ['380', '380', '320'], material: null, flute: null, quantity: '800', unitPrice: '2.1234', deliveryDate: '2026-12-08' })],
  },
  {
    id: 'O2', kind: 'order', title: 'Excel 缺订单日期，只有行交期',
    file: () => FILES.orderXlsx({ noDate: true }),
    header: { buyerName: '虚构东海电器有限公司', purchaseOrderNumber: null, orderDate: null, deliveryDate: '2026-12-08', taxRate: null, taxMode: null },
    lines: [line({ productName: '电饭煲外箱 3L', code: null, size: ['420', '320', '300'], material: null, flute: null, quantity: '600', unitPrice: '1.35', deliveryDate: '2026-12-01' }), line({ productName: '水壶外箱', code: null, size: ['380', '380', '320'], material: null, flute: null, quantity: '800', unitPrice: '2.1234', deliveryDate: '2026-12-08' })],
  },
  {
    id: 'O3', kind: 'order', title: '手写样的图片，一行、交期没写年份',
    file: () => FILES.orderPng(),
    header: { buyerName: '虚构北仑灯具', purchaseOrderNumber: null, orderDate: null, deliveryDate: '12-05', taxRate: null, taxMode: null },
    lines: [line({ productName: '灯具内托箱', code: null, size: ['620', '180', '180'], material: null, flute: null, quantity: '1800', unitPrice: '0.9500', deliveryDate: ['12-05', null] })],
  },
  {
    id: 'O4', kind: 'order', title: '扫描件样的 PDF，三行，两行同名不同规格，带料号',
    file: () => imagePdf('虚构采购订单-慈溪.pdf', [
      '虚构慈溪小家电有限公司 采购订单（测试数据）',
      '订单号：CX-PO-0451    订单日期：2026-11-12    交货日期：2026-12-10',
      '料号      品名            规格(mm)        材质   楞型   数量(只)   单价(元)   备注',
      'CX-1001   五金配件箱 小    300×200×150    A=A    B      1000       0.8800',
      'CX-1002   五金配件箱 小    320×220×160    A=A    B      500        0.9100     加印防潮标',
      'CX-2001   吹风机彩箱       260×110×240    W=A    E      1200       1.2600',
    ], ['Fictional test document']),
    header: { buyerName: '虚构慈溪小家电有限公司', purchaseOrderNumber: 'CX-PO-0451', orderDate: '2026-11-12', deliveryDate: '2026-12-10', taxRate: null, taxMode: null },
    lines: [
      line({ productName: '五金配件箱 小', code: 'CX-1001', size: ['300', '200', '150'], material: 'A=A', flute: 'B', quantity: '1000', unitPrice: '0.8800', deliveryDate: [null, '2026-12-10'] }),
      line({ productName: '五金配件箱 小', code: 'CX-1002', size: ['320', '220', '160'], material: 'A=A', flute: 'B', quantity: '500', unitPrice: '0.9100', deliveryDate: [null, '2026-12-10'], notes: '加印防潮标' }),
      line({ productName: '吹风机彩箱', code: 'CX-2001', size: ['260', '110', '240'], material: 'W=A', flute: 'E', quantity: '1200', unitPrice: '1.2600', deliveryDate: [null, '2026-12-10'] }),
    ],
  },
  {
    id: 'O5', kind: 'order', title: 'Word 表格，含税 13%，日期写成中文',
    file: async () => {
      const { Document, Packer, Paragraph, Table, TableRow, TableCell } = require('docx');
      const cell = (s) => new TableCell({ children: [new Paragraph(String(s))] });
      const rows = [
        ['品名', '料号', '规格（长×宽×高 mm）', '材质', '楞型', '数量（只）', '单价（元）', '交期', '备注'],
        ['食品礼盒外箱', 'MY-A01', '500×350×260', 'B=B', 'BE', '2400', '3.4500', '2026-12-10', '客户自提'],
        ['五金配件箱 小', 'MY-B07', '300×200×150', 'A=A', 'B', '1200', '0.9', '2026-12-15', ''],
      ];
      const doc = new Document({ sections: [{ children: [
        new Paragraph('虚构明远食品有限公司 订货单（测试数据）'),
        new Paragraph('订单编号：MY-2611-08；下单日期：2026年11月13日；价格含13%增值税'),
        new Table({ rows: rows.map((r) => new TableRow({ children: r.map(cell) })) }),
      ] }] });
      return { name: '虚构订货单-明远.docx', bytes: await Packer.toBuffer(doc) };
    },
    header: { buyerName: '虚构明远食品有限公司', purchaseOrderNumber: 'MY-2611-08', orderDate: '2026-11-13', deliveryDate: '2026-12-15', taxRate: '13', taxMode: '含税' },
    lines: [line({ productName: '食品礼盒外箱', code: 'MY-A01', size: ['500', '350', '260'], material: 'B=B', flute: 'BE', quantity: '2400', unitPrice: '3.4500', deliveryDate: '2026-12-10', notes: '客户自提' }), line({ productName: '五金配件箱 小', code: 'MY-B07', size: ['300', '200', '150'], material: 'A=A', flute: 'B', quantity: '1200', unitPrice: '0.9', deliveryDate: '2026-12-15' })],
  },
  {
    id: 'O6', kind: 'order', title: 'Excel 六行，只有行交期，两行同名不同高',
    file: () => xlsx('虚构采购订单-余姚.xlsx', [
      ['虚构余姚塑料制品有限公司 采购订单（测试数据）'],
      ['订单号', 'YY-PO-3307', '订单日期', '2026-11-10'],
      ['序号', '料号', '品名', '长', '宽', '高', '尺寸单位', '材质', '楞型', '数量（只）', '单价（元）', '交货日期', '备注'],
      [1, 'YY-01', '塑料件周转箱', 600, 400, 300, 'mm', 'K=K', 'AB', 300, 6.5, '2026-11-28', ''],
      [2, 'YY-02', '塑料件周转箱', 600, 400, 250, 'mm', 'K=K', 'AB', 200, 6.2, '2026-11-28', '矮款'],
      [3, 'YY-03', '五金配件箱 大', 450, 300, 250, 'mm', 'K=K', 'BC', 800, 2.35, '2026-12-02', ''],
      [4, 'YY-04', '电饭煲外箱 5L', 480, 360, 340, 'mm', 'K=A', 'BC', 1000, 2.8, '2026-12-05', ''],
      [5, 'YY-05', '灯具内托箱', 620, 180, 180, 'mm', 'B=B', 'E', 1500, 0.96, '2026-12-05', '分两批'],
      [6, 'YY-06', '水壶外箱', 380, 380, 320, 'mm', 'K=A', 'BC', 400, 2.12, '2026-12-12', ''],
    ]),
    header: { buyerName: '虚构余姚塑料制品有限公司', purchaseOrderNumber: 'YY-PO-3307', orderDate: '2026-11-10', deliveryDate: '2026-12-12', taxRate: null, taxMode: null },
    lines: [
      line({ productName: '塑料件周转箱', code: 'YY-01', size: ['600', '400', '300'], material: 'K=K', flute: 'AB', quantity: '300', unitPrice: '6.5', deliveryDate: '2026-11-28' }),
      line({ productName: '塑料件周转箱', code: 'YY-02', size: ['600', '400', '250'], material: 'K=K', flute: 'AB', quantity: '200', unitPrice: '6.2', deliveryDate: '2026-11-28', notes: '矮款' }),
      line({ productName: '五金配件箱 大', code: 'YY-03', size: ['450', '300', '250'], material: 'K=K', flute: 'BC', quantity: '800', unitPrice: '2.35', deliveryDate: '2026-12-02' }),
      line({ productName: '电饭煲外箱 5L', code: 'YY-04', size: ['480', '360', '340'], material: 'K=A', flute: 'BC', quantity: '1000', unitPrice: '2.8', deliveryDate: '2026-12-05' }),
      line({ productName: '灯具内托箱', code: 'YY-05', size: ['620', '180', '180'], material: 'B=B', flute: 'E', quantity: '1500', unitPrice: '0.96', deliveryDate: '2026-12-05', notes: '分两批' }),
      line({ productName: '水壶外箱', code: 'YY-06', size: ['380', '380', '320'], material: 'K=A', flute: 'BC', quantity: '400', unitPrice: '2.12', deliveryDate: '2026-12-12' }),
    ],
  },
  {
    id: 'A1', kind: 'arrival', title: '送货单照片，一行',
    file: () => FILES.deliveryNotePng(),
    header: { supplierName: '虚构鼎盛纸业', reference: 'DS-SH-3308', purchaseNumber: null, date: '2026-11-14' },
    lines: [{ name: 'BC五层纸板', length: '1250', width: '1000', dimensionUnit: null, material: 'K=A', flute: ['BC', null], quantity: '600', area: null, unitPrice: null, priceBasis: null }],
  },
  {
    id: 'A2', kind: 'arrival', title: '扫描件样的 PDF 送货单，两行，按面积计价',
    file: () => imagePdf('虚构送货单-华美.pdf', [
      '虚构华美瓦楞 送货单（测试数据）',
      '送货单号：HM-SD-2201    送货日期：2026-11-13    采购单号：CG-20261110-0009',
      '品名           规格(mm)       材质   楞型   数量(张)   面积(㎡)    单价',
      'BC五层纸板     1250×1000     K=A    BC     800        1000.00     3.5400元/㎡',
      'BE五层纸板     1400×1100     B=B    BE     300        462.00      3.1500元/㎡',
    ]),
    header: { supplierName: '虚构华美瓦楞', reference: 'HM-SD-2201', purchaseNumber: 'CG-20261110-0009', date: '2026-11-13' },
    lines: [
      { name: 'BC五层纸板', length: '1250', width: '1000', dimensionUnit: 'mm', material: 'K=A', flute: 'BC', quantity: '800', area: '1000', unitPrice: '3.5400', priceBasis: 'area' },
      { name: 'BE五层纸板', length: '1400', width: '1100', dimensionUnit: 'mm', material: 'B=B', flute: 'BE', quantity: '300', area: '462', unitPrice: '3.1500', priceBasis: 'area' },
    ],
  },
  {
    id: 'A3', kind: 'arrival', title: 'Excel 送货单，尺寸是厘米，按张计价',
    file: () => xlsx('虚构送货单-宏泰.xlsx', [
      ['虚构宏泰纸板厂 送货单（测试数据）'],
      ['单号', 'HT-0091', '日期', '2026-11-12'],
      ['品名', '长(cm)', '宽(cm)', '材质', '楞型', '数量(张)', '单价(元/张)'],
      ['E三层纸板', 80, 60, 'W=A', 'E', 450, 0.85],
      ['B三层纸板', 90, 70, 'A=A', 'B', 300, 1.1],
    ]),
    header: { supplierName: '虚构宏泰纸板厂', reference: 'HT-0091', purchaseNumber: null, date: '2026-11-12' },
    lines: [
      { name: 'E三层纸板', length: '80', width: '60', dimensionUnit: 'cm', material: 'W=A', flute: 'E', quantity: '450', area: null, unitPrice: '0.85', priceBasis: 'quantity' },
      { name: 'B三层纸板', length: '90', width: '70', dimensionUnit: 'cm', material: 'A=A', flute: 'B', quantity: '300', area: null, unitPrice: '1.1', priceBasis: 'quantity' },
    ],
  },
  // 难一点的三份：供需双方都写了、未税价、日期写法杂；手写样的要货单（中文数字、“个”、没写年份、“月底前”）；送货单上发货和收货单位都有
  {
    id: 'O7', kind: 'order', title: 'Excel 采购合同：需方和供方都写了，未税价，原文有行金额',
    file: () => xlsx('虚构采购合同-慈溪.xlsx', [
      ['采购合同（测试数据）'],
      ['需方：虚构慈溪小家电有限公司', '', '供方：宁波甬勒包装制品有限公司'],
      ['合同号：CX-HT-2026-118', '', '签订日期：2026/11/09'],
      ['交货期：2026年12月20日前', '', '税率：13%（单价为未税价）'],
      ['物料编码', '名称', '规格', '数量', '单位', '未税单价', '金额', '备注'],
      ['M-300-A', '五金配件箱 小', '300*200*150mm', 2000, '只', 0.82, 1640, ''],
      ['M-450-B', '五金配件箱 大', '450*300*250mm', 600, '只', 2.4, 1440, '外箱印logo'],
      ['合计', '', '', 2600, '', '', 3080, ''],
    ]),
    header: { buyerName: '虚构慈溪小家电有限公司', purchaseOrderNumber: 'CX-HT-2026-118', orderDate: '2026-11-09', deliveryDate: '2026-12-20', taxRate: '13', taxMode: '未税' },
    lines: [
      line({ productName: '五金配件箱 小', code: 'M-300-A', size: ['300', '200', '150'], material: null, flute: null, quantity: '2000', unitPrice: '0.82', deliveryDate: [null, '2026-12-20'], notes: null, statedAmount: '1640' }),
      line({ productName: '五金配件箱 大', code: 'M-450-B', size: ['450', '300', '250'], material: null, flute: null, quantity: '600', unitPrice: '2.4', deliveryDate: [null, '2026-12-20'], notes: ['外箱印logo', null], statedAmount: '1440' }),
    ],
  },
  {
    id: 'O8', kind: 'order', title: '手写样的要货单：中文数字、写“个”、没写年份、“月底前送”',
    file: async () => ({ name: '虚构要货单-海曙.png', bytes: (await textImage(['虚构海曙五金制品厂  要货单（测试数据）', '日期：11月11日', '1. 五金配件箱 大  450x300x250  一千二百个  单价2.4元', '2. 五金配件箱 小  300x200x150  800个  单价0.85元', '月底前送，送到二号仓库'], { size: 30 })).bytes }),
    header: { buyerName: '虚构海曙五金制品厂', purchaseOrderNumber: null, orderDate: '11-11', deliveryDate: [null, '11-30'], taxRate: null, taxMode: null },
    lines: [
      line({ productName: '五金配件箱 大', code: null, size: ['450', '300', '250'], material: null, flute: null, quantity: '1200', unitPrice: '2.4', deliveryDate: [null, '11-30'], notes: null, unit: ['只', '个'] }),
      line({ productName: '五金配件箱 小', code: null, size: ['300', '200', '150'], material: null, flute: null, quantity: '800', unitPrice: '0.85', deliveryDate: [null, '11-30'], notes: null, unit: ['只', '个'] }),
    ],
  },
  {
    id: 'A4', kind: 'arrival', title: '送货单照片：发货和收货单位都写了，带采购单号和备注',
    file: async () => ({ name: '虚构送货单-华美2.png', bytes: (await textImage(['送货单（测试数据）  No. HM-SD-2234', '发货单位：虚构华美瓦楞      收货单位：宁波甬勒包装（虚构）', '日期：2026年11月14日   订单号：CG-20261108-0007', '纸板  B三层  900*700  A=A  1100张', '备注：其中20张边角受潮'], { size: 28 })).bytes }),
    header: { supplierName: '虚构华美瓦楞', reference: 'HM-SD-2234', purchaseNumber: 'CG-20261108-0007', date: '2026-11-14' },
    lines: [{ name: ['B三层纸板', '纸板B三层', 'B三层'], length: '900', width: '700', dimensionUnit: null, material: 'A=A', flute: ['B', null], quantity: '1100', area: null, unitPrice: null, priceBasis: null }],
  },
];

// 尺寸单位：原件写了 mm 的算 mm，没写的（O1–O3、O8 的“420×320×300”）应当留空
for (const c of CASES.filter((x) => x.kind === 'order')) for (const l of c.lines) l.dimensionUnit = ['O4', 'O5', 'O6', 'O7'].includes(c.id) ? 'mm' : null;

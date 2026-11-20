// 单据导出的信息格名字（“收货地址”“客户联系信息”这类）同时是模板里“隐藏这一格”的钥匙，也是预览和导出排版认格子的名字。
// 这里用虚构数据真的拼几份送货单、订货单（待送货和已出库的送货单；一张、几张分批的订货单），套上填满我方资料和条款的模板，
// 收集写出的全部格子名，和排版（shared/documents/document-layout.ts 的 splitFields、templateInfoFields，预览和导出共用）、
// 可隐藏清单（optionalDocumentFields）比：
// - 拼单据写的每一格，排版都认得（单号、日期、我方资料、条款，或这类单据的信息格），不然印不出来；
// - 信息格排了的每一格，拼单据都会写，不然永远印“未填写”（改了一边的叫法另一边没跟上就是这样）；
// - 可隐藏清单里的每一格，总有一种单据会写，并且勾了隐藏以后预览、导出都不再出现。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDocumentTemplate } from '../server/documents/apply-template.js';
import { deliveryForm } from '../server/documents/delivery-form.js';
import { purchaseForm } from '../server/documents/purchase-form.js';
import {
  defaultDocumentTemplates,
  optionalDocumentFields,
  splitFields,
  templateInfoFields,
  type BusinessForm,
  type DocumentKind,
} from '../shared/documents/index.js';
import { actor } from './assistant-fixture.js';
import { setup } from './document-fixture.js';

/** 填满我方资料和条款的模板（这些格子只在填了时才印），hidden 是勾了隐藏的格子 */
function fullTemplate(kind: DocumentKind, hidden: readonly string[] = []) {
  const base = defaultDocumentTemplates().templates.find((t) => t.kind === kind);
  if (!base) throw new Error('没有 ' + kind + ' 的默认模板');
  const filled = '虚构内容';
  return {
    ...base,
    companyContact: filled,
    companyPhone: '000-0000',
    companyAddress: filled,
    deliveryTerms: filled,
    acceptanceTerms: filled,
    paymentTerms: filled,
    hiddenFields: optionalDocumentFields.filter((k) => hidden.includes(k)),
  };
}

/** 虚构数据拼出的各种单据（套模板之前）：两种送货单、一张和两张分批的订货单 */
function sampleForms(): Record<DocumentKind, BusinessForm[]> {
  const f = setup();
  const pending = f.saveDelivery('100'),
    shipped = f.confirm(f.saveDelivery('200'));
  const other = f.ops.saveItem({ name: '虚构纸板B', kind: 'raw', unit: '张', length: 900, width: 700, dimensionUnit: 'mm' }, actor);
  const second = f.ops.savePurchase(
    {
      supplierId: f.purchase.supplierId,
      orderDate: '2026-10-30',
      expectedDate: '2026-11-09',
      status: '待订货',
      lines: [{ ...other, stockItemId: other.id, quantity: '500', unitPrice: '2.5', priceBasis: 'quantity' }],
    },
    actor,
  );
  return {
    delivery: [deliveryForm(f.store, pending.id).form, deliveryForm(f.store, shipped.id).form],
    purchase: [purchaseForm(f.store, [f.purchase.id]).form, purchaseForm(f.store, [f.purchase.id, second.id]).form],
  };
}

/** 排版把这个名字的格子放在哪：单号、日期、我方资料、条款，或者是信息格（splitFields 真放一次看） */
function placeOf(name: string) {
  const split = splitFields({ number: '', fields: [[name, '虚构值']], draft: false });
  if (split.number === '虚构值') return 'number';
  if (split.date) return 'date';
  if (split.own.length) return 'own';
  if (split.terms.length) return 'term';
  return 'info';
}

/**
 * 一种单据写出的格子名和排版对不上的地方：写了排版不认的信息格；排版排了、拼单据从来不写的信息格。
 * infoCells 是这类单据的信息格（templateInfoFields）
 */
function layoutMismatches(kind: DocumentKind, written: readonly string[], infoCells: readonly string[]) {
  const unknown = written
    .filter((k) => placeOf(k) === 'info' && !infoCells.includes(k))
    .map((k) => `${kind}：拼单据写了“${k}”，可排版的信息格里没有它，预览和导出都印不出来`);
  const neverWritten = infoCells
    .filter((k) => !written.includes(k))
    .map((k) => `${kind}：排版排了“${k}”这一格，可拼单据从来不写，永远印“未填写”`);
  return [...unknown, ...neverWritten];
}

/** 可隐藏清单里，哪种单据都不写的格子（隐藏开关勾了也没用） */
const unusedHideable = (hideable: readonly string[], written: ReadonlySet<string>) =>
  hideable.filter((k) => !written.has(k)).map((k) => `可隐藏清单里有“${k}”，可两种单据都不写这一格`);

const kinds: DocumentKind[] = ['delivery', 'purchase'];
const formsByKind = sampleForms();
/** 一种单据套上模板以后写出的全部格子名 */
const writtenNames = (kind: DocumentKind, hidden: readonly string[] = []) => [
  ...new Set(formsByKind[kind].flatMap((form) => applyDocumentTemplate(form, fullTemplate(kind, hidden)).fields.map(([k]) => k))),
];

test('单据导出写出的信息格名字，预览和导出的排版都认得；排版排的格子拼单据都会写', () => {
  // 样例走到了各个分支：送货单的两种日期，订货单分批时的交货安排和合并时的对应采购单
  assert.ok(['实际送货日期', '预计送货日期'].every((k) => writtenNames('delivery').includes(k)), '送货单两种日期都拼到了');
  assert.ok(['交货安排', '对应采购单'].every((k) => writtenNames('purchase').includes(k)), '订货单分批、合并都拼到了');
  const problems = kinds.flatMap((kind) =>
    layoutMismatches(kind, writtenNames(kind), templateInfoFields(kind, [], fullTemplate(kind).companyAddress)),
  );
  assert.deepEqual(
    problems,
    [],
    '拼单据（server/documents/delivery-form.ts、purchase-form.ts、apply-template.ts）和排版' +
      '（shared/documents/document-layout.ts）的格子名对不上：改叫法要两边一起改',
  );
});

test('可隐藏清单的每一格都有单据会写，勾了隐藏以后写出的格子和排版的信息格里都没有它', () => {
  const written = new Set(kinds.flatMap((kind) => writtenNames(kind)));
  assert.deepEqual(
    unusedHideable(optionalDocumentFields, written),
    [],
    'shared/documents/document-templates.ts 的 optionalDocumentFields 里有拼单据不写的名字：叫法改了要一起改，不用了就删掉',
  );
  for (const kind of kinds) {
    const hidden = writtenNames(kind, optionalDocumentFields).filter((k) => optionalDocumentFields.some((h) => h === k));
    const cells = templateInfoFields(kind, optionalDocumentFields, fullTemplate(kind).companyAddress);
    assert.deepEqual(hidden, [], kind + ' 勾了隐藏的格子还写在单据上');
    assert.deepEqual(cells.filter((k) => optionalDocumentFields.some((h) => h === k)), [], kind + ' 勾了隐藏的格子还排在信息格里');
  }
});

test('格子名的检查真的会拦：排版不认的、排了没人写的、可隐藏却没人写的都报出来，对得上的放过', () => {
  assert.equal(placeOf('送货单号'), 'number');
  assert.equal(placeOf('付款条件'), 'term');
  assert.deepEqual(layoutMismatches('delivery', ['送货单号', '客户', '虚构新格'], ['客户', '虚构旧格']), [
    'delivery：拼单据写了“虚构新格”，可排版的信息格里没有它，预览和导出都印不出来',
    'delivery：排版排了“虚构旧格”这一格，可拼单据从来不写，永远印“未填写”',
  ]);
  assert.deepEqual(layoutMismatches('delivery', ['送货单号', '客户'], ['客户']), []);
  assert.deepEqual(unusedHideable(['客户联系信息', '虚构可隐藏格'], new Set(['客户联系信息'])), [
    '可隐藏清单里有“虚构可隐藏格”，可两种单据都不写这一格',
  ]);
});

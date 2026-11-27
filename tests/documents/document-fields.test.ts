// 单据字段登记表（shared/documents/document-fields.ts）及派生行为（document-layout.ts、document-templates.ts）：
// 按具体结果断言可隐藏清单顺序与字面值、信息格清单、splitFields 分区、打印名称和宽格实际占列。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fieldLabel } from '../../shared/core/index.js';
import {
  deliveryDateLabels,
  docField,
  documentFields,
  optionalDocumentFields,
  packInfo,
  printedInfoName,
  splitFields,
  templateInfoFields,
} from '../../shared/documents/index.js';

/** 用 splitFields 拆单条字段，返回它实际落进的唯一区域 */
function actualZoneOf(key: string) {
  const split = splitFields({ number: 'FALLBACK', fields: [[key, '值']], draft: false });
  const zones: string[] = [];
  if (split.number === '值') zones.push('number');
  if (split.date?.[0] === key) zones.push('date');
  if (split.own.some(([k]) => k === key)) zones.push('own');
  if (split.info.some(([k]) => k === key)) zones.push('info');
  if (split.terms.some(([k]) => k === key)) zones.push('term');
  assert.equal(zones.length, 1, `字段“${key}”被分进了 ${zones.length} 个区域：${zones.join('、')}`);
  return zones[0];
}

test('登记表键名唯一，optionalDocumentFields 保持兼容的 11 项存储键与展示顺序', () => {
  const keys = documentFields.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length, '登记表里的字段键不能重复');
  assert.equal(keys.length, 22);
  assert.ok(
    documentFields.every((f) => f.kinds.length > 0),
    '每个单据字段至少适用于一种单据',
  );
  assert.deepEqual(optionalDocumentFields, [
    '供应商联系信息',
    '客户联系信息',
    '预计交货日期',
    '我方联系人',
    '交货地址',
    '客户采购订单号',
    '关联销售订单',
    '交货要求',
    '验收要求',
    '付款条件',
    '税费说明',
  ]);
  assert.deepEqual(docField('customerOrderNumber', 'PO-9'), ['客户采购订单号', 'PO-9']);
  assert.deepEqual(docField('shippedDate', '2026-11-01'), [deliveryDateLabels.shipped, '2026-11-01']);
});

test('templateInfoFields 按单据种类、我方地址和隐藏清单返回准确的信息格顺序', () => {
  assert.deepEqual(templateInfoFields('purchase', [], ''), ['供应商', '供应商联系信息', '预计交货日期']);
  assert.deepEqual(templateInfoFields('purchase', [], '虚构我方地址'), [
    '供应商',
    '供应商联系信息',
    '预计交货日期',
    '交货地址',
  ]);
  assert.deepEqual(templateInfoFields('purchase', ['预计交货日期', '交货地址'], '虚构我方地址'), [
    '供应商',
    '供应商联系信息',
  ]);
  assert.deepEqual(templateInfoFields('delivery', [], '虚构我方地址'), [
    '客户',
    '收货地址',
    '客户联系信息',
    '关联销售订单',
    '客户采购订单号',
  ]);
  assert.deepEqual(templateInfoFields('delivery', ['客户联系信息', '客户采购订单号'], '虚构我方地址'), [
    '客户',
    '收货地址',
    '关联销售订单',
  ]);
});

test('splitFields 把登记表里的每个字段分到唯一且正确的区域', () => {
  for (const field of documentFields) {
    assert.equal(actualZoneOf(field.key), field.zone, `字段“${field.key}”的区域应为 ${field.zone}`);
  }
  const deliverySplit = splitFields({
    number: 'FALLBACK',
    draft: false,
    fields: [
      docField('deliveryNumber', 'SH-1'),
      docField('shippedDate', '2026-11-23'),
      docField('companyContact', '张三'),
      docField('companyAddress', '工厂路 1 号'),
      docField('customer', '虚构客户'),
      docField('deliveryAddress', '收货路 2 号'),
      docField('customerOrderNumber', 'PO-8'),
    ],
  });
  assert.equal(deliverySplit.number, 'SH-1');
  assert.deepEqual(deliverySplit.date, [deliveryDateLabels.shipped, '2026-11-23']);
  assert.deepEqual(
    deliverySplit.own.map(([k]) => k),
    ['我方联系人', '我方地址'],
  );
  assert.deepEqual(
    deliverySplit.info.map(([k]) => k),
    ['客户', '收货地址', '客户采购订单号'],
  );
  assert.deepEqual(deliverySplit.terms, []);

  const purchaseSplit = splitFields({
    number: 'FALLBACK',
    draft: false,
    fields: [
      docField('purchaseNumber', 'CG-1'),
      docField('orderDate', '2026-11-23'),
      docField('supplier', '虚构纸板厂'),
      docField('deliverySchedule', '第一批 11-25'),
      docField('paymentTerms', '月结 30 天'),
    ],
  });
  assert.equal(purchaseSplit.number, 'CG-1');
  assert.deepEqual(purchaseSplit.date, ['下单日期', '2026-11-23']);
  assert.deepEqual(
    purchaseSplit.info.map(([k]) => k),
    ['供应商'],
  );
  assert.deepEqual(
    purchaseSplit.terms.map(([k]) => k),
    ['交货安排', '付款条件'],
  );
});

test('printedInfoName 与 packInfo 宽格占列：客户采购订单号印成客户采购单号，地址格实际占 2 格', () => {
  assert.equal(printedInfoName('客户采购订单号'), fieldLabel('externalPurchaseOrder'));
  assert.equal(printedInfoName('收货地址'), '收货地址');
  assert.equal(printedInfoName('交货地址'), '交货地址');

  const deliveryPacked = packInfo(
    [
      docField('deliveryAddress', '收货路 2 号'),
      docField('customer', '虚构客户'),
      docField('customerOrderNumber', 'PO-8'),
    ],
    3,
  );
  assert.deepEqual(deliveryPacked, [
    [
      { k: '收货地址', v: '收货路 2 号', slots: 2 },
      { k: '客户', v: '虚构客户', slots: 1 },
    ],
    [{ k: fieldLabel('externalPurchaseOrder'), v: 'PO-8', slots: 3 }],
  ]);

  const purchasePacked = packInfo(
    [
      docField('purchaseDeliveryAddress', '我方收货路 1 号'),
      docField('supplier', '虚构纸板厂'),
      docField('expectedDeliveryDate', '2026-11-30'),
    ],
    3,
  );
  assert.deepEqual(purchasePacked, [
    [
      { k: '交货地址', v: '我方收货路 1 号', slots: 2 },
      { k: '供应商', v: '虚构纸板厂', slots: 1 },
    ],
    [{ k: '预计交货日期', v: '2026-11-30', slots: 3 }],
  ]);
});

// 到货识别：识别前的检查、识别结果转成到货单时的校验、挂哪份订货单。识别完资料齐的直接登记成待入库到货单（页面在 src/import/useArrivalDraft.ts）。
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareArrivalRecognition } from '../server/import/arrival-recognition.js';
import { ImportManager } from '../server/import/manager.js';
import { ReceiptAi } from '../server/import/receipt-ai.js';
import { Store } from '../server/core/index.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { supplierDefaultPreset } from '../server/import/default-prompts/supplier-delivery.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { recognizedArrivalDraft, arrivalDraftIssues, matchArrivalBatch, batchKeysFor } from '../shared/business/arrival-draft.js';
import { fakeAiSettings } from './fake-deepseek.js';
import { workspaceRecord } from './import-fixtures.js';
import { tempDir } from './order-import-fixture.js';

const admin = localAdministratorActor(pageActor({
  id: 'fixture-owner',
  name: '虚构维护',
  role: 'super_admin',
  permissions: ['business:edit'],
  superAdminMode: true,
  superAdminUntil: Date.now() + 3600000,
}));

test('到货识别没填 DeepSeek 密钥就停下，不读原件、不外发', async () => {
  const temp = tempDir('erp-arrival-no-key-');
  const { settings } = fakeAiSettings({ saveKey: false });
  const store = new Store(':memory:');
  const prompts = new PromptPresetManager(':memory:', supplierDefaultPreset);
  const manager = new ImportManager({ directory: temp.dir, settings });
  const receiptAi = new ReceiptAi(store, settings, prompts);
  try {
    manager.get = () => workspaceRecord({ id: 'w', mode: 'arrival', revision: 1, fileHash: '虚构' });
    manager.original = async () => {
      throw new Error('不该读原件');
    };
    receiptAi.upload = () => {
      throw new Error('不该外发');
    };
    manager.linkArrival = () => {
      throw new Error('不该挂原件');
    };
    await assert.rejects(prepareArrivalRecognition(manager, receiptAi, 'w', admin), /还没填写 DeepSeek 密钥/);
  } finally {
    manager.close();
    prompts.close();
    settings.close();
    store.close();
    temp.remove();
  }
});

test('到货单单位未知导致数量为空时，识别结果校验返回提示而不是抛异常', () => {
  const source = {
    id: '1fe56051-fe31-4af2-90e4-142382907154',
    result: {
      supplierName: '虚构供应商',
      reference: 'SH-TEST-01',
      purchaseNumber: null,
      date: '2025-10-21',
      notes: '',
      warnings: [],
      lines: [
        {
          name: '纸板',
          specification: '2280*902',
          material: 'N264M-BC',
          flute: null,
          length: null,
          width: null,
          dimensionUnit: null,
          quantity: '3000',
          unit: null,
          area: '6128.64',
          unitPrice: '6.18',
          priceBasis: null,
          notes: '',
        },
      ],
    },
  };
  const draft = recognizedArrivalDraft(source, []).draft;
  assert.doesNotThrow(() => arrivalDraftIssues(draft));
  assert.ok(
    arrivalDraftIssues(draft).some((issue) => issue.includes('数量')),
    '应提示数量格式待修正',
  );
});

/** 还没到齐的订货单（/api/order-batches 的样子）里对订货单要用的部分 */
const board = (name: string, length: number, width: number) => ({
  name, specification: '', length, width, height: null, dimensionUnit: 'mm', material: 'K=A', flute: 'B',
});
const openBatch = (id: number, supplierId: number, rows: [string, ReturnType<typeof board>][]) => ({
  id, supplierId, number: 'DG-虚构-' + id, rows: rows.map(([key, b]) => ({ key, board: b })),
});
const recognized = (lines: { name: string; length: string; width: string; quantity: string }[]) => ({
  id: '00000000-0000-4000-8000-000000000001',
  result: {
    supplierName: '虚构春芳纸板厂', date: '2026-11-10', reference: '虚构送货单-识别',
    lines: lines.map((l) => ({ ...l, unit: '张', dimensionUnit: 'mm', material: 'K=A', flute: 'B', specification: '' })),
  },
});

test('AI 识别的送货单挂订货单：同一家供应商只有一份每行都对得上的才自动挂，对不上列进要补的项', () => {
  const suppliers = [{ id: 7, name: '虚构春芳纸板厂' }];
  const a = openBatch(1, 7, [['行甲', board('虚构纸板甲', 1000, 800)], ['行乙', board('虚构纸板乙', 1200, 900)]]),
    b = openBatch(2, 7, [['行丙', board('虚构纸板丙', 500, 400)]]),
    other = openBatch(3, 8, [['行甲2', board('虚构纸板甲', 1000, 800)]]);
  const source = recognized([{ name: '纸板（供应商叫法）', length: '1000', width: '800', quantity: '300' }]);
  // 规格一样就算对上（名称按供应商的叫法，不比），别家供应商的订货单不算
  const draft = recognizedArrivalDraft(source, suppliers, undefined, [a, b, other]).draft;
  assert.equal(draft.orderBatchId, 1);
  assert.deepEqual(batchKeysFor(draft.lines, a), ['行甲']);
  assert.deepEqual(arrivalDraftIssues(draft, a), []);
  // 两份订货单都对得上：不猜，留给人选
  const twin = openBatch(4, 7, [['行甲3', board('虚构纸板甲', 1000, 800)]]);
  const unsure = recognizedArrivalDraft(source, suppliers, undefined, [a, twin]).draft;
  assert.equal('orderBatchId' in unsure, false);
  assert.ok(arrivalDraftIssues(unsure).some((i) => i.startsWith('订货单：')), '要补：选哪份订货单');
  // 有一行哪份都对不上
  const odd = recognized([
    { name: '虚构纸板甲', length: '1000', width: '800', quantity: '300' },
    { name: '没订过的纸板', length: '700', width: '700', quantity: '10' },
  ]);
  assert.equal(matchArrivalBatch(7, recognizedArrivalDraft(odd, suppliers).draft.lines, [a, b]), null);
  // 人选了订货单，但有一行在这份订货单里没有
  const chosen = { ...recognizedArrivalDraft(odd, suppliers, undefined, []).draft, orderBatchId: 1 };
  assert.deepEqual(
    arrivalDraftIssues(chosen, a).filter((i) => i.includes('订货单')),
    ['第2行：订货单 DG-虚构-1 里没有这种纸板，请改选订货单或选“不挂采购单”'],
  );
  // 选了“不挂采购单”（供应商多送、样品）：不再要求订货单
  assert.deepEqual(arrivalDraftIssues({ ...unsure, withoutPurchase: true }).filter((i) => i.includes('订货单')), []);
  // 同规格两行时再比名称
  const same = openBatch(5, 7, [['行名甲', board('虚构纸板甲', 1000, 800)], ['行名乙', board('虚构纸板乙', 1000, 800)]]);
  assert.deepEqual(batchKeysFor([{ item: board('虚构纸板乙', 1000, 800) }], same), ['行名乙']);
  assert.equal(batchKeysFor([{ item: board('别的名字', 1000, 800) }], same), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizedArrivalDraft, arrivalDraftIssues } from '../shared/arrival-draft.js';

test('到货单单位未知导致数量为空时，草稿问题校验返回提示而不是抛异常', () => {
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

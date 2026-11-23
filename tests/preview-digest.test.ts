// 预览摘要的公共件（server/core/storage/preview-digest.ts）：同样内容摘要相同、内容变了摘要变、字段顺序无关；对不上抛同一种错。
import assert from 'node:assert/strict';
import test from 'node:test';
import { PREVIEW_CHANGED } from '../server/core/storage/preview-digest.js';
import { previewDigestSchema } from '../shared/core/index.js';
import { assertPreviewCurrent, previewDigest, AppError } from '../server/core/index.js';

test('预览摘要：同样内容相同，字段先后（各层）不算，数组先后和值都算；格式是 64 位十六进制', () => {
  const a = { id: 1, lines: [{ stockId: 2, delta: '+5' }, { stockId: 3, delta: '-1' }], doc: { version: 4, notes: '虚构' } };
  const shuffled = { doc: { notes: '虚构', version: 4 }, lines: [{ delta: '+5', stockId: 2 }, { delta: '-1', stockId: 3 }], id: 1 };
  assert.equal(previewDigest(a), previewDigest(shuffled));
  assert.equal(previewDigest(a), previewDigest(structuredClone(a)));
  assert.ok(previewDigestSchema.safeParse(previewDigest(a)).success);
  const changed = [
    { ...a, doc: { ...a.doc, version: 5 } },
    { ...a, lines: [...a.lines].reverse() },
    { ...a, lines: [{ stockId: 2, delta: '+6' }, a.lines[1]] },
    { ...a, extra: null },
  ];
  for (const c of changed) assert.notEqual(previewDigest(c), previewDigest(a));
});

test('对不上（含没带）抛同一种错：409、类别 preview-changed、同一句话；对上了不抛', () => {
  const current = previewDigest({ x: 1 });
  assert.doesNotThrow(() => assertPreviewCurrent(current, current));
  for (const given of [undefined, previewDigest({ x: 2 })])
    assert.throws(
      () => assertPreviewCurrent(given, current),
      (e: unknown) => e instanceof AppError && e.status === 409 && e.code === 'preview-changed' && e.message === PREVIEW_CHANGED,
    );
});

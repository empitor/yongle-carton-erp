// 识别导入的核心规则直接测：原文件怎么交给模型（source-file.ts）、订单识别结果的校验
// （order-recognition.ts）、识别结果的修改（order-draft-edits.ts）、工作区目录启动修复（workspace-files.ts）。
// 不起整个系统：模型用假 DeepSeek，工作区用临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fakeAiSettings, httpError } from './fake-deepseek.js';
import { docxFixture, imageFixture, pdfFixture, workspaceRecord, xlsxFixture, zipFixture } from './import-fixtures.js';
import { SOURCE_DELIVERY, sourceDelivery, withSourceFile } from '../server/import/source-file.js';
import { usableAnalysis } from '../server/import/order-recognition.js';
import { formatZodIssues } from '../server/import/zod-issues.js';
import { orderFormSchema } from '../shared/import/order-form.js';
import { applyDraftOperations, applyMapping, undoDraftEdit, type EditableWorkspace } from '../server/import/order-draft-edits.js';
import { repairWorkspaceFiles } from '../server/import/workspace-files.js';
import { ImportRepository } from '../server/import/repository.js';
import { blankField, headerFields, lineFields, orderDraftSchema, type OrderDraft } from '../shared/import/order-draft.js';
import type { ImportMapping } from '../shared/import/import-mapping.js';
import { errorMessage } from '../shared/core/index.js';
import { listen } from './http-fixture.js';

test('上传用途只有一处规则：表格按数据、PDF和Word按带版式的文档、图片内联；别的格式不交', () => {
  assert.deepEqual(SOURCE_DELIVERY['.xls'], { purpose: 'user_data' });
  assert.deepEqual(sourceDelivery('订单.XLSX'), { purpose: 'user_data' });
  for (const name of ['a.pdf', 'a.doc', 'a.docx'])
    assert.deepEqual(sourceDelivery(name), { purpose: 'rich_layout_recognition' });
  assert.deepEqual(sourceDelivery('a.png'), { inline: 'image/png' });
  assert.deepEqual(sourceDelivery('a.jpeg'), { inline: 'image/jpeg' });
  for (const name of ['a.txt', 'a.csv', 'a.pptx', 'a']) assert.throws(() => sourceDelivery(name), /不能交给模型识别/);
});

test('文档原样上传一次，job 里重试几次都用同一个文件编号，结束后删除；图片内联不上传', async () => {
  const { settings, fake } = fakeAiSettings();
  try {
    const bytes = docxFixture(),
      seen: string[] = [];
    const result = await withSourceFile(settings, { name: '虚构订单.docx', data: bytes }, async (message) => {
      assert.ok(Array.isArray(message.content));
      const [intro, file] = message.content;
      assert.ok(intro?.type === 'text');
      assert.ok(file?.type === 'file');
      assert.match(intro.text, /原文件《虚构订单\.docx》/);
      for (let i = 0; i < 2; i++) {
        seen.push(file.file_id);
        assert.ok(fake.files.has(file.file_id), '用的时候文件还在');
      }
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(new Set(seen).size, 1);
    const uploads = fake.calls.filter((c) => c.path === '/files' && c.method === 'POST');
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].body.purpose, 'rich_layout_recognition');
    assert.equal(uploads[0].body['expires_after[seconds]'], '3600');
    assert.deepEqual(uploads[0].body.file?.bytes, bytes, '原样上传');
    assert.equal(fake.files.size, 0, '用完删除');

    const image = imageFixture();
    await withSourceFile(settings, { name: '照片.png', data: image }, async (message) => {
      assert.ok(Array.isArray(message.content));
      const part = message.content[1];
      assert.equal(part.type, 'image_url');
      assert.ok('image_url' in part);
      assert.equal(part.image_url.url, 'data:image/png;base64,' + image.toString('base64'));
      assert.equal(part.image_url.detail, 'high', '原图、高细节');
    });
    await withSourceFile(settings, { name: '表.xlsx', data: xlsxFixture() }, async () => {});
    assert.equal(fake.calls.filter((c) => c.path === '/files' && c.method === 'POST').length, 2, '图片没上传、表格上传了');
    const upload = fake.calls.findLast((c) => c.path === '/files' && c.method === 'POST');
    assert.ok(upload);
    assert.equal(upload.body.purpose, 'user_data');
  } finally {
    settings.close();
  }
});

test('识别失败、取消也删文件；删不掉不影响结果；上传失败不进 job；宏文件在外发前就拦下', async () => {
  const { settings, fake } = fakeAiSettings();
  try {
    const pdf = await pdfFixture();
    await assert.rejects(
      withSourceFile(settings, { name: '失败.pdf', data: pdf }, async () => {
        throw new Error('虚构的模型失败');
      }),
      /虚构的模型失败/,
    );
    assert.equal(fake.files.size, 0);

    const controller = new AbortController();
    await assert.rejects(
      withSourceFile(
        settings,
        { name: '取消.pdf', data: pdf },
        async () => {
          controller.abort();
          throw new Error('已取消');
        },
        controller.signal,
      ),
    );
    assert.equal(fake.files.size, 0, '取消了也删');

    fake.next('/files/:id', httpError(500).response);
    assert.equal(await withSourceFile(settings, { name: '删不掉.pdf', data: pdf }, async () => 'ok'), 'ok');
    assert.equal(fake.files.size, 1, '留下的靠 1 小时过期');

    fake.next('/files', httpError(400, { error: { message: 'file is encrypted' } }).response);
    let entered = false;
    await assert.rejects(
      withSourceFile(settings, { name: '有密码.pdf', data: pdf }, async () => {
        entered = true;
      }),
    );
    assert.equal(entered, false);

    const before = fake.calls.length;
    const macro = zipFixture({
      '[Content_Types].xml': '<Types><Default Extension="xml" ContentType="application/xml"/></Types>',
      'xl/workbook.xml': '<workbook/>',
      'xl/vbaProject.bin': 'x',
    });
    await assert.rejects(withSourceFile(settings, { name: '宏.xlsx', data: macro }, async () => {}), /宏/);
    assert.equal(fake.calls.length, before, '没发出去');
  } finally {
    settings.close();
  }
});

const field = (value: string | null) => (value === null ? blankField() : { ...blankField(), value, certainty: 'recognized' as const });
function draft(): OrderDraft {
  const header = Object.fromEntries(headerFields.map((k) => [k, blankField()]));
  const fields = Object.fromEntries(lineFields.map((k) => [k, blankField()]));
  Object.assign(fields, {
    productName: field('虚构纸箱'),
    quantity: field('1000'),
    unitPrice: field('1.3900'),
    unit: field('只'),
    length: field('30'),
    width: field('20'),
    height: field('10'),
    dimensionUnit: field('cm'),
  });
  return orderDraftSchema.parse({ header, lines: [{ id: randomUUID(), fields }], warnings: [] });
}

test('订单识别结果：一行能用的明细都没有就不合格', () => {
  // 模型交回的是填好的表：一格就是文字
  const lines = [{ productName: '虚构纸箱' }];
  assert.equal(usableAnalysis({ header: {}, lines, warnings: [] }).lines.length, 1);
  assert.throws(() => usableAnalysis({ header: {}, lines: [{}], warnings: [] }), /没有识别到可用订单明细/);
});

test('识别结果的修改：换尺寸单位时长宽高跟着换算，可撤回；没有校验器不收“已有档案”的匹配', () => {
  const initial = draft();
  const w: EditableWorkspace = { draft: initial, history: [], mapping: undefined, mappingInvalidated: undefined, changes: [] };
  const lineId = initial.lines[0].id;
  const changes = applyDraftOperations(w, [{ op: 'set-line', lineId, field: 'dimensionUnit', value: 'mm', reason: '改单位' }], 'manual');
  assert.ok(w.draft);
  assert.equal(w.draft.lines[0].fields.length.value, '300');
  assert.equal(w.draft.lines[0].fields.height.value, '100');
  assert.equal(changes.length, 4);
  assert.throws(
    () => applyDraftOperations(w, [{ op: 'set-line', lineId, field: 'quantity', value: '-1', reason: 'x' }], 'ai'),
    /非负十进制数/,
  );
  undoDraftEdit(w);
  assert.ok(w.draft);
  assert.equal(w.draft.lines[0].fields.length.value, '30');
  assert.throws(() => undoDraftEdit(w), /没有可撤回/);
  const mapping: ImportMapping = { customer: { mode: 'existing', id: 1, version: 1 }, products: {}, roundingPolicy: 'exact-cents' };
  let checked = 0;
  applyMapping(w, mapping, () => void checked++);
  assert.equal(checked, 1);
  assert.equal(w.mapping, mapping);
});

test('工作区目录启动修复：正在删的目录里，库里还在的搬回，库里没有的清掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-workspace-repair-'));
  const repo = new ImportRepository(join(dir, 'workspaces.sqlite'));
  try {
    const active = randomUUID(),
      orphan = randomUUID();
    repo.insert(workspaceRecord({ id: active, fileHash: 'h', revision: 0, fileName: '虚构.pdf', task: { state: 'uploaded' } }));
    mkdirSync(join(dir, '_deleting', active), { recursive: true });
    writeFileSync(join(dir, '_deleting', active, 'original'), 'x');
    mkdirSync(join(dir, '_deleting', orphan), { recursive: true });
    repairWorkspaceFiles(dir, repo);
    assert.ok(existsSync(join(dir, active, 'original')), '库里还在，原件搬回正常目录');
    assert.ok(!existsSync(join(dir, '_deleting', orphan)), '库里没有的清掉');
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('识别地址的回法只有一处（ai-stream.ts）：不推送回 JSON；推送先报连接中、再给结果或中文错误；正常结束不算断开', async () => {
  const express = (await import('express')).default;
  const { replyAi, aiFailureMessage } = await import('../server/import/ai-stream.js');
  const { AppError } = await import('../server/core/errors.js');
  let aborted = 0;
  const app = express();
  app.use(express.json());
  const input = z.object({ stream: z.boolean(), fail: z.boolean().optional() });
  app.post('/run', async (req, res) => {
    try {
      const body = input.parse(req.body);
      await replyAi(req, res, {
        stream: body.stream,
        abort: () => aborted++,
        run: async (progress) => {
          progress?.({ stage: 'validating', receivedChars: 3, elapsedMs: 0 });
          if (body.fail) throw new AppError('虚构的失败', 422);
          return { ok: true };
        },
        failure: (error) => ({ message: aiFailureMessage(error, '格式不对', '请求失败') }),
      });
    } catch (error) {
      res.status(422).json({ message: errorMessage(error) });
    }
  });
  const server = await listen(app);
  const url = server.origin + '/run';
  const post = (body: unknown) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await (await post({ stream: false })).json(), { ok: true });
    const failed = await post({ stream: false, fail: true });
    assert.equal(failed.status, 422);
    assert.deepEqual(await failed.json(), { message: '虚构的失败' });
    const text = await (await post({ stream: true })).text();
    assert.match(text, /^event: progress\ndata: \{"stage":"connecting"/);
    assert.match(text, /event: progress\ndata: \{"stage":"validating"/);
    assert.match(text, /event: result\ndata: \{"ok":true\}/);
    const error = await (await post({ stream: true, fail: true })).text();
    assert.match(error, /event: error\ndata: \{"message":"虚构的失败"\}/);
    assert.equal(aborted, 0, '正常结束不算断开');
  } finally {
    await server.close();
  }
  const { ZodError } = await import('zod');
  assert.equal(aiFailureMessage(new ZodError([]), '格式不对', '请求失败'), '格式不对');
  assert.equal(aiFailureMessage(new Error('内部细节'), '格式不对', '请求失败'), '请求失败');
});

test('识别中途页面断开：停掉模型调用一次', async () => {
  const express = (await import('express')).default;
  const { replyAi } = await import('../server/import/ai-stream.js');
  let aborted = 0,
    finish!: () => void;
  const running = new Promise<void>((r) => (finish = r));
  const app = express();
  app.post('/run', (req, res) =>
    replyAi(req, res, { stream: true, abort: () => aborted++, run: () => running, failure: () => ({}) }),
  );
  const server = await listen(app);
  const page = new AbortController();
  try {
    const res = await fetch(server.origin + '/run', { method: 'POST', signal: page.signal });
    assert.ok(res.body);
    const reader = res.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /connecting/);
    page.abort();
    for (let i = 0; i < 200 && !aborted; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(aborted, 1);
  } finally {
    finish();
    await server.close();
  }
});

test('识别结果校验不过：说中文栏目名，超过 8 个写“等字段”，不露英文路径', () => {
  const issues = (raw: unknown) => {
    const r = orderFormSchema.safeParse(raw);
    assert.equal(r.success, false);
    assert.ok(r.error);
    return formatZodIssues(r.error);
  };
  const one = issues({ header: {}, lines: [{ quantity: true }], uncertain: [{ field: 'quantity', reason: true }] });
  assert.match(one, /数量/);
  assert.doesNotMatch(one, /[A-Za-z]/, one);
  const header = Object.fromEntries(['buyerName', 'supplierName', 'purchaseOrderNumber', 'orderDate', 'deliveryDate', 'currency', 'taxRate', 'taxMode', 'statedTotalQuantity'].map((k) => [k, true]));
  const many = issues({ header, lines: [{ productName: '虚构纸箱' }] });
  assert.match(many, /等字段/);
  assert.doesNotMatch(many, /[A-Za-z]/, many);
});

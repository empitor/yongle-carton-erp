import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiWorkQueue } from '../server/ai/work-queue.js';
import { AiConnectionError } from '../server/ai/connection-error.js';
import { makeSettings, protector, secret } from './assistant-fixture.js';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { ImportManager } from '../server/import/manager.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { docxFixture } from './import-fixtures.js';
import { headerFields, lineFields } from '../shared/order-draft.js';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('并发设置与已有密钥模型重开本地配置库后仍保留，不因旧自动连接保存而覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-queue-persistence-')),
    file = join(dir, 'settings.sqlite');
  let s = new AiSettingsManager({ file, protector });
  try {
    let v = s.saveDraft({
      name: '虚构持久预设',
      endpoint: 'https://api.example.com/v1',
      apiKey: secret,
      model: 'test-model',
      apiStyle: 'responses',
      expectedRevision: 0,
    });
    v = s.activate({ id: v.presets[0].id, expectedRevision: v.revision });
    s.preferences({ expectedRevision: v.revision, recognitionConcurrency: 2, autoConnect: true });
    s.close();
    s = new AiSettingsManager({ file, protector });
    assert.equal(s.view().recognitionConcurrency, 2);
    assert.equal(s.view().autoConnect, true);
    assert.equal(s.view().active?.model, 'test-model');
    assert.equal(s.view().active?.hasApiKey, true);
    assert(!JSON.stringify(s.view()).includes(secret));
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('六份任务最多三个同时执行，逐份结果独立、失败隔离、队列不重复混淆', async () => {
  let active = 0,
    max = 0;
  const q = new AiWorkQueue(() => 3),
    states: any[] = [];
  const result = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) =>
      q.run(
        async () => {
          active++;
          max = Math.max(max, active);
          try {
            await sleep(20);
            if (i === 2) throw new Error('独立失败');
            return '文件' + i;
          } finally {
            active--;
          }
        },
        undefined,
        (s) => states.push({ i, ...s }),
      ),
    ),
  );
  assert.equal(max, 3);
  assert.equal(result[2].status, 'rejected');
  assert.equal((result[5] as any).value, '文件5');
  assert(states.some((s) => s.state === 'queued'));
  assert.equal(q.stats().active, 0);
});
test('明确429降为串行并有限退避重试，超时不自动重发，排队任务可取消', async () => {
  let calls = 0;
  const q = new AiWorkQueue(() => 3, 2);
  const keep = setInterval(() => {}, 50);
  try {
    const r = await q.run(async () => {
      if (calls++ === 0) throw new AiConnectionError('rate_limit', '限流', 429);
      return 'ok';
    });
    assert.equal(r, 'ok');
    assert.equal(calls, 2);
    assert.equal(q.limit, 1);
    let unknown = 0;
    await assert.rejects(() =>
      q.run(async () => {
        unknown++;
        throw new AiConnectionError('timeout', '可能已处理', 504);
      }),
    );
    assert.equal(unknown, 1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      first = q.run(() => gate),
      controller = new AbortController(),
      cancelled = q.run(async () => {
        throw new Error('不能发出');
      }, controller.signal);
    controller.abort();
    await assert.rejects(() => cancelled, /取消/);
    release();
    await first;
  } finally {
    clearInterval(keep);
  }
});
test('识别并发配置默认3、持久逻辑校验1～6、旧自动连接操作不覆盖并发值', () => {
  const s = makeSettings(async () => ({ status: 200, body: {} }));
  try {
    assert.equal(s.view().recognitionConcurrency, 3);
    const v = s.preferences({ expectedRevision: s.view().revision, recognitionConcurrency: 1 });
    assert.equal(v.recognitionConcurrency, 1);
    assert.equal(
      s.preferences({ expectedRevision: v.revision, autoConnect: true }).recognitionConcurrency,
      1,
    );
    assert.throws(() =>
      s.preferences({ expectedRevision: s.view().revision, recognitionConcurrency: 7 }),
    );
  } finally {
    s.close();
  }
});
test('后台异步识别返回排队状态、独立保存原文件草稿、重复入队不增加调用，失败文件可重试', async () => {
  let active = 0,
    max = 0,
    calls = 0;
  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r)),
    deadline = setTimeout(() => release(), 5000);
  const header = Object.fromEntries(
      headerFields.map((k) => [k, { value: null, certainty: 'needs-review', note: '' }]),
    ),
    line = Object.fromEntries(
      lineFields.map((k) => [k, { value: null, certainty: 'needs-review', note: '' }]),
    );
  line.productName.value = '虚构纸箱' as any;
  const perFile = new Map<string, number>();
  const s = makeSettings(async (req) => {
      calls++;
      const part = (req.body as any).input
          .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
          .find((p: any) => p.type === 'input_file'),
        filename = part.filename;
      perFile.set(filename, (perFile.get(filename) || 0) + 1);
      active++;
      max = Math.max(max, active);
      if (active === 3) release();
      await barrier;
      await sleep(25);
      active--;
      if (filename === '订单2.docx' && perFile.get(filename) === 1)
        throw new AiConnectionError('timeout', '虚构中断，不自动重试', 504);
      return {
        status: 200,
        body: {
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    header,
                    lines: [{ ...line, productName: { ...line.productName, value: filename } }],
                    warnings: [],
                  }),
                },
              ],
            },
          ],
        },
      };
    }),
    dir = mkdtempSync(join(tmpdir(), 'erp-concurrent-import-')),
    manager = new ImportManager({ directory: dir, settings: s });
  try {
    const jobs = [];
    for (let i = 0; i < 6; i++) {
      let w = (
        await manager.upload(
          Buffer.concat([docxFixture(), Buffer.from('独立文件' + i)]),
          '订单' + i + '.docx',
        )
      ).workspace;
      const p = s.view().active!;
      w = manager.consent(w.id, {
        expectedRevision: w.revision,
        accepted: true,
        presetId: p.id,
        endpoint: p.endpoint,
        model: p.model,
        apiStyle: 'responses',
      });
      jobs.push(w);
      manager.enqueue(w.id, { expectedRevision: w.revision, stream: false });
      manager.enqueue(w.id, { expectedRevision: w.revision, stream: false });
    }
    while (jobs.some((w) => manager.isBusy(w.id))) await sleep(10);
    assert.equal(calls, 6);
    assert.equal(max, 3);
    const failed = manager.get(jobs[2].id);
    assert.equal(failed.task?.state, 'failed');
    assert(!failed.draft);
    manager.enqueue(failed.id, { expectedRevision: failed.revision, stream: false });
    while (manager.isBusy(failed.id)) await sleep(10);
    assert.equal(calls, 7);
    for (const [i, w] of jobs.entries()) {
      const result = manager.get(w.id);
      assert.equal(result.task?.state, 'ready');
      assert.equal(result.fileHash, w.fileHash);
      assert.equal(result.draft?.lines[0].fields.productName.value, '订单' + i + '.docx');
    }
  } finally {
    clearTimeout(deadline);
    manager.close();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { completeResponses } from '../server/ai/compatible-responses.js';
import { responsesFilePart, responsesInput, responsesText } from '../server/ai/responses-format.js';
import { ImportManager } from '../server/import/manager.js';
import { headerFields, lineFields, blankField } from '../shared/order-draft.js';
import { xlsxFixture, docxFixture, pdfFixture } from './import-fixtures.js';
import type { WireRequest, AiTransport } from '../server/ai/transport.js';
const key = 'sk-fictional-responses-test-key',
  cryptoKey = randomBytes(32),
  profile = {
    provider: 'compatible' as const,
    endpoint: 'https://api.example.com/v1',
    model: 'test-model',
    apiStyle: 'responses' as const,
  };
const protector = {
  protect(s: string) {
    return encrypt(s, randomBytes(12));
  },
  unprotect(s: string) {
    const b = Buffer.from(s, 'base64'),
      c = createDecipheriv('aes-256-gcm', cryptoKey, b.subarray(0, 12));
    c.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString();
  },
};
function encrypt(s: string, iv: Buffer) {
  const c = createCipheriv('aes-256-gcm', cryptoKey, iv),
    data = Buffer.concat([c.update(s), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}
function reply(text: string) {
  return {
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [] },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      },
    ],
  };
}
const fields = { name: '协议测试预设', endpoint: profile.endpoint, model: profile.model };
const transport: AiTransport = async (r) => {
  if (r.method === 'GET')
    return r.headers.Authorization
      ? { status: 200, body: { data: [{ id: profile.model }] } }
      : { status: 401, body: {} };
  const marker = JSON.stringify(r.body).match(/ERP_OK_[a-f0-9]{12}/)?.[0] || '{}';
  return {
    status: 200,
    body: r.url.pathname.endsWith('/responses')
      ? reply(marker)
      : { choices: [{ finish_reason: 'stop', message: { content: marker } }] },
  };
};

test('Responses转换文字、图片及Word/Excel/PDF原件，拒绝URL与伪装文件', async () => {
  const XLSX = await import('xlsx'),
    book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['虚构订单', 1.3]]), '订单');
  const files: [string, Buffer][] = [
    ['a.docx', docxFixture()],
    ['a.xlsx', xlsxFixture()],
    ['a.pdf', await pdfFixture()],
    [
      'a.doc',
      readFileSync(new URL('./fixtures/import/word-extractor-test01.doc', import.meta.url)),
    ],
    ['a.xls', XLSX.write(book, { type: 'buffer', bookType: 'biff8' })],
  ];
  for (const [name, bytes] of files) {
    const part = responsesFilePart(name, bytes),
      input: any = responsesInput([
        { role: 'system', content: 'JSON规则' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '读取文件' },
            part,
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,aGVsbG8=', detail: 'high' },
            },
          ],
        },
      ]);
    assert.equal(input[1].content[1].type, 'input_file');
    assert.equal(input[1].content[1].filename, name);
    assert.ok(Buffer.from(input[1].content[1].file_data.split(',')[1], 'base64').equals(bytes));
    assert.equal(input[1].content[2].type, 'input_image');
    assert.equal(input[1].content[2].detail, 'high');
  }
  assert.throws(() => responsesFilePart('a.pdf', Buffer.from('fake')));
  assert.throws(() => responsesFilePart('../a.docx', docxFixture()));
  assert.throws(() =>
    responsesInput([
      {
        role: 'user',
        content: [
          { type: 'file', file: { filename: 'a.pdf', file_data: 'http://127.0.0.1/source' } },
        ],
      },
    ]),
  );
});

test('Responses请求使用input/max_output_tokens/text.format/store:false，解析reasoning后文本JSON', async () => {
  let request: WireRequest | undefined;
  const result = await completeResponses(
    profile,
    key,
    [{ role: 'user', content: '返回JSON' }],
    async (r) => {
      request = r;
      return { status: 200, body: reply('{"ok":true}') };
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(request!.url.pathname, '/v1/responses');
  const body = request!.body as any;
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 7000);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.messages, undefined);
  assert.deepEqual(body.text, { format: { type: 'json_object' } });
});

test('Responses拒绝截断、失败、拒答、意外工具调用、非JSON与密钥回显，错误不透传', async () => {
  for (const body of [
    { ...reply('{}'), status: 'incomplete' },
    { ...reply('{}'), status: 'failed' },
    reply('not-json'),
    reply(JSON.stringify({ key })),
    {
      status: 'completed',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: key }] },
      ],
    },
    { status: 'completed', output: [{ type: 'function_call', name: 'sql', arguments: 'DELETE' }] },
    { status: 'completed', output_text: '{}' },
  ])
    await assert.rejects(
      completeResponses(profile, key, [{ role: 'user', content: 'JSON' }], async () => ({
        status: 200,
        body,
      })),
      (e: any) => !e.message.includes(key),
    );
  assert.equal(responsesText(reply('完整输出')), '完整输出');
});

test('第三方不支持Responses时明确失败且不偷偷调用聊天补全', async () => {
  const calls: WireRequest[] = [];
  await assert.rejects(
    completeResponses(profile, key, [{ role: 'user', content: 'JSON' }], async (r) => {
      calls.push(r);
      return { status: 404, body: { error: { message: key } } };
    }),
    (e: any) => e.message.includes('Responses') && !e.message.includes(key),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/v1/responses');
});

test('协议持久保存、沿用加密密钥、旧预设默认聊天补全，自动连接仍只GET', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-responses-settings-')),
    file = join(dir, 'settings.sqlite'),
    calls: WireRequest[] = [];
  let m = new AiSettingsManager({
    file,
    protector,
    transport: async (r) => {
      calls.push(r);
      return transport(r);
    },
  });
  try {
    let view = m.saveDraft({ ...fields, apiKey: key, expectedRevision: 0 });
    const id = view.presets[0].id;
    view = m.activate({ id, expectedRevision: view.revision });
    assert.equal(view.active!.apiStyle, 'chat-completions');
    view = m.saveDraft({ ...fields, id, apiStyle: 'responses', expectedRevision: view.revision });
    assert.equal(view.active!.hasApiKey, true);
    assert.equal(view.active!.apiStyle, 'responses');
    view = m.preferences({ autoConnect: true, expectedRevision: view.revision });
    m.close();
    calls.length = 0;
    m = new AiSettingsManager({
      file,
      protector,
      transport: async (r) => {
        calls.push(r);
        return transport(r);
      },
    });
    assert.equal(m.view().active!.apiStyle, 'responses');
    await m.startup();
    assert.ok(calls.length > 0);
    assert.ok(calls.every((r) => r.method === 'GET'));
    assert.ok(!readFileSync(file).includes(Buffer.from(key)));
    const result = await m.test({
      ...fields,
      id,
      apiStyle: 'responses',
      expectedRevision: m.view().revision,
    });
    view = m.save({ testToken: result.testToken, expectedRevision: m.view().revision });
    assert.equal(view.active!.apiStyle, 'responses');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Responses测试失败不覆盖当前聊天补全预设、连接状态或密钥', async () => {
  let rejectResponses = false;
  const m = new AiSettingsManager({
    protector,
    transport: async (r) =>
      rejectResponses && r.url.pathname.endsWith('/responses')
        ? { status: 405, body: {} }
        : transport(r),
  });
  try {
    const tested = await m.test({ ...fields, apiKey: key, expectedRevision: 0 });
    const before = m.save({ testToken: tested.testToken, expectedRevision: 0 });
    rejectResponses = true;
    await assert.rejects(
      m.test({
        ...fields,
        id: before.active!.id,
        apiStyle: 'responses',
        expectedRevision: before.revision,
      }),
    );
    assert.deepEqual(m.view(), before);
    await assert.rejects(
      m.completeOrderJson([{ role: 'user', content: 'JSON' }], {
        id: before.active!.id,
        ...fields,
        apiStyle: 'responses',
      }),
      (e: any) => e.code === 'stale',
    );
  } finally {
    m.close();
  }
});

test('现有文件入口在Responses下发送原件，协议变更需要新外发授权，正式执行仍禁用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-responses-import-')),
    requests: WireRequest[] = [];
  const f = (value: string) => ({
    ...blankField(),
    value,
    sources: ['source-1'],
    quote: value,
    certainty: 'recognized' as const,
    note: '',
  });
  const header = Object.fromEntries(headerFields.map((k) => [k, blankField()]));
  header.buyerName = f('虚构客户');
  const row = Object.fromEntries(lineFields.map((k) => [k, blankField()]));
  Object.assign(row, {
    productName: f('虚构纸箱'),
    quantity: f('1'),
    unitPrice: f('1.3000'),
    unit: f('只'),
  });
  const settings = new AiSettingsManager({
    protector,
    transport: async (r) => {
      requests.push(r);
      return { status: 200, body: reply(JSON.stringify({ header, lines: [row], warnings: [] })) };
    },
  });
  const view = settings.saveDraft({
    ...fields,
    apiStyle: 'responses',
    apiKey: key,
    expectedRevision: 0,
  });
  settings.activate({ id: view.presets[0].id, expectedRevision: view.revision });
  const manager = new ImportManager({
    directory: dir,
    settings,
    parser: async (bytes, name, id, path) => {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'original'), bytes);
      return {
        format: name.endsWith('.pdf') ? 'pdf' : name.endsWith('.docx') ? 'docx' : 'xlsx',
        blocks: [
          {
            id: 'source-1',
            text: '虚构客户 虚构纸箱 数量1 单价1.3000 只',
            ref: { kind: 'document', fileId: id, paragraph: 1 },
            method: 'xml',
          },
        ],
        previews: [],
        imagePages: [],
        warnings: [],
      };
    },
  });
  try {
    const p = settings.view().active!;
    for (const [name, bytes] of [
      ['a.docx', docxFixture()],
      ['a.xlsx', xlsxFixture()],
      ['a.pdf', await pdfFixture()],
    ] as const) {
      let w = (await manager.upload(bytes, name)).workspace;
      assert.throws(() =>
        manager.consent(w.id, {
          expectedRevision: w.revision,
          accepted: true,
          presetId: p.id,
          endpoint: p.endpoint,
          model: p.model,
        }),
      );
      w = manager.consent(w.id, {
        expectedRevision: w.revision,
        accepted: true,
        presetId: p.id,
        endpoint: p.endpoint,
        model: p.model,
        apiStyle: 'responses',
      });
      w = await manager.analyze(w.id, { expectedRevision: w.revision });
      assert.equal(w.draft!.lines[0].fields.unitPrice.value, '1.3000');
      const body = requests.at(-1)!.body as any,
        parts = body.input.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
      assert.equal(parts.filter((p: any) => p.type === 'input_file').length, 1);
      assert.equal(parts.find((p: any) => p.type === 'input_file').filename, name);
      assert.equal(manager.status().writesEnabled, false);
    }
  } finally {
    manager.close();
    settings.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

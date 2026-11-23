// 助手和 DeepSeek 的一次次对话：思考档位按账号记住、调错工具不把请求打挂、
// 上传到 DeepSeek 的文档留 7 天、快到期再用就重传、删掉的不再带给模型且远端那份跟着删。
// 附件怎么放进用户消息见 assistant-attachment-reading.test.ts。假 DeepSeek、内存库、虚构数据，不发真实请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pdfFixture } from '../support/import-fixtures.js';
import { FILE_RENEW_MS, FILE_TTL_SECONDS } from '../../server/assistant/chat/model-attachments.js';
import { assistantFixture } from '../support/assistant-fixture.js';
import { contentParts, httpError, replyNative } from '../support/fake-deepseek.js';
import { actor } from '../support/actor-fixture.js';

const answer = (message: string) => ({ message, toolCalls: [] });
/** 模型按 replies 回答，排完了说“好的。”；fake 是假 DeepSeek（记下的请求、存着的上传文件） */
const chatFixture = (replies: unknown[] = []) => assistantFixture([], { chat: () => replies.shift() ?? answer('好的。') });
type Fixture = ReturnType<typeof chatFixture>;
const chatBodies = (f: Fixture) => f.fake.chatCalls().map((r) => r.body);
const uploads = (f: Fixture) => f.fake.calls.filter((r) => r.path === '/files' && r.method === 'POST').length;
const remote = (f: Fixture) => [...f.fake.files.keys()];

test('思考档位：带了就用这次的并记成这个账号的默认，没带用记住的；关掉时请求里不开思考', async () => {
  const f = chatFixture([answer('一。'), answer('二。'), answer('三。')]);
  try {
    const thread = f.manager.create(actor);
    assert.equal(f.manager.state(actor).thinking, 'high', '默认高');
    await f.say(thread.id, '你好', { thinking: 'low' });
    assert.equal(chatBodies(f).at(-1)?.reasoning_effort, 'low');
    assert.equal(f.manager.state(actor).thinking, 'low');
    await f.say(thread.id, '再说');
    assert.equal(chatBodies(f).at(-1)?.reasoning_effort, 'low', '记住了');
    await f.say(thread.id, '关掉思考', { thinking: 'off' });
    const off = chatBodies(f).at(-1);
    assert.deepEqual(off?.thinking, { type: 'disabled' });
    assert.ok(off?.messages.every((m) => m.reasoning_content === undefined), '关了思考，历史里也不带思考内容');
    await assert.rejects(f.say(thread.id, '乱填', { thinking: 'ultra' }), /thinking|Invalid/);
  } finally {
    f.close();
  }
});

// 走命令目录时执行目录里没有的命令，由 assistant-boundaries「界限 3」守
test('调了没声明过的函数：不执行，从回传的助手消息里拿掉，用 system 消息说明后再问一轮，请求不被拒', async () => {
  const f = chatFixture([replyNative({ toolCalls: [{ name: 'nope__tool', arguments: {} }] }), answer('换个办法。')]);
  try {
    const view = await f.say(f.manager.create(actor).id, '做点什么');
    assert.equal(view.messages.at(-1)?.text, '换个办法。');
    const second = chatBodies(f)[1];
    const replied = second.messages.filter((m) => m.role === 'assistant').at(-1);
    assert.ok(replied && !replied.tool_calls, '没声明过的调用不回传');
    assert.ok(second.messages.some((m) => m.role === 'system' && typeof m.content === 'string' && /nope__tool.*没有执行|没有执行.*nope__tool/.test(m.content)));
  } finally {
    f.close();
  }
});

test('上传到 DeepSeek 的文档留 7 天：后几轮接着用同一份；快到期时再用到就重新上传一份；删掉了的换成一句话', async () => {
  const f = chatFixture();
  try {
    const thread = f.manager.create(actor);
    const pdf = await f.manager.attachments.upload(thread.id, await pdfFixture(), '订单.pdf', randomUUID(), actor);
    await f.say(thread.id, '看看这份', { attachmentIds: [pdf.id] });
    const sentFiles = () =>
      (chatBodies(f).at(-1)?.messages ?? []).flatMap((m) => contentParts(m)).filter((p) => p.type === 'file').map((p) => p.file_id);
    const [first] = sentFiles();
    assert.ok(first, '发给模型的是上传后的文件');
    assert.equal(f.fake.files.get(first)?.expiresSeconds, FILE_TTL_SECONDS);
    assert.equal(f.fake.calls.filter((r) => r.method === 'DELETE').length, 0, '这一轮结束不删，后面几轮还要看');
    await f.say(thread.id, '刚才那份订单还在吗');
    assert.deepEqual(sentFiles(), [first]);
    assert.equal(uploads(f), 1);
    // 离到期不到 1 小时：再用到时重新上传一份，历史里那一处换成新编号
    f.store.db
      .prepare("UPDATE assistant_messages SET document=json_set(document,'$.turn.files.' || ? || '.expiresAt', ?) WHERE json_extract(document,'$.turn.files.' || ?) IS NOT NULL")
      .run('"' + first + '"', Date.now() + FILE_RENEW_MS - 60_000, '"' + first + '"');
    await f.say(thread.id, '再看一眼');
    const [renewed] = sentFiles();
    assert.ok(renewed && renewed !== first && !renewed.startsWith('erp-'), '换成了新上传的编号');
    assert.equal(uploads(f), 2);
    await f.say(thread.id, '还在吗');
    assert.deepEqual(sentFiles(), [renewed]);
    assert.equal(uploads(f), 2);
    f.manager.removeAttachment(pdf.id, actor);
    await f.say(thread.id, '删了以后呢');
    assert.deepEqual(sentFiles(), []);
    assert.match(JSON.stringify(chatBodies(f).at(-1)?.messages),/附件《订单\.pdf》已经删掉了，看不到了/);
    assert.equal(uploads(f), 2);
  } finally {
    f.close();
  }
});

test('用户删了就是删了：删掉的附件回放时不再带给模型，传到 DeepSeek 的那份跟着删；清空会话、删会话也删；接口调不通本地照删、下次再试', async () => {
  const f = chatFixture();
  try {
    const deletes = () => f.fake.calls.filter((r) => r.method === 'DELETE').map((r) => decodeURIComponent(r.path.slice('/files/'.length)));
    const sent = () => JSON.stringify(chatBodies(f).at(-1)?.messages);
    const thread = f.manager.create(actor);
    const txt = await f.manager.attachments.upload(thread.id, Buffer.from('附件正文：虚构验收317'), '说明.txt', randomUUID(), actor);
    const pdf = await f.manager.attachments.upload(thread.id, await pdfFixture(), '订单.pdf', randomUUID(), actor);
    await f.say(thread.id, '看看这两份', { attachmentIds: [txt.id, pdf.id] });
    const [fileId] = remote(f);
    assert.ok(sent().includes(fileId));
    f.manager.removeAttachment(pdf.id, actor);
    await f.manager.deleteRemoteFiles(actor);
    assert.deepEqual(deletes(), [fileId]);
    assert.deepEqual(remote(f), []);
    await f.say(thread.id, '订单那份还在吗');
    assert.ok(!sent().includes(fileId), '删掉的上传不再发给模型');
    assert.match(sent(), /附件《订单\.pdf》已经删掉了，看不到了/);
    assert.ok(sent().includes('虚构验收317'));
    f.manager.removeAttachment(txt.id, actor);
    await f.say(thread.id, '说明那份呢');
    assert.ok(!sent().includes('虚构验收317'), '删掉的文字附件原文不再发给模型');
    assert.match(sent(), /附件《说明\.txt》已经删掉了，看不到了/);
    // 删会话时接口调不通（当时试一次、下面再等一次都不通）：本地照删，记着，下次再试
    const second = f.manager.create(actor);
    const other = await f.manager.attachments.upload(second.id, await pdfFixture(), '合同.pdf', randomUUID(), actor);
    await f.say(second.id, '看看合同', { attachmentIds: [other.id] });
    const [otherFile] = remote(f);
    f.fake.next('/files/:id', httpError(500).response());
    f.fake.next('/files/:id', httpError(500).response());
    f.manager.removeThread(second.id, actor);
    await f.manager.deleteRemoteFiles(actor);
    assert.throws(() => f.manager.view(second.id, actor), '本地已经删了');
    assert.deepEqual(remote(f), [otherFile], '这两次没删成');
    await f.manager.deleteRemoteFiles(actor);
    assert.deepEqual(remote(f), [], '下次再试时删掉了');
    // 清空会话：传上去的也删
    const third = f.manager.create(actor);
    const more = await f.manager.attachments.upload(third.id, await pdfFixture(), '报价.pdf', randomUUID(), actor);
    await f.say(third.id, '看看报价', { attachmentIds: [more.id] });
    assert.equal(remote(f).length, 1);
    f.manager.clear(third.id, actor);
    await f.manager.deleteRemoteFiles(actor);
    assert.deepEqual(remote(f), []);
  } finally {
    f.close();
  }
});

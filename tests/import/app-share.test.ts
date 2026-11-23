// 安卓 App 分享进来的文件（src/import/app-share.ts）：先判账号、有弹层先等，导入页就绪才要文件，收到的每一份都回结果
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppShare, type ShareReply } from '../../src/import/app-share.js';
import { MAX_FILE_BYTES, NOT_READY, TOO_LARGE, type UploadReport } from '../../src/import/useUploadQueue.js';
import type { NoticeTone } from '../../src/ui/events.js';

const offer = (shareId: string, names: string[], size = 3) => ({
  type: 'share-offer',
  shareId,
  files: names.map((name) => ({ name, mime: 'application/pdf', size })),
});
const part = (shareId: string, index: number, text: string) => ({
  type: 'share-file',
  shareId,
  index,
  data: Buffer.from(text).toString('base64'),
});

/** layersOpen：一开始有没有开着的弹层（closeLayers 把它们都关掉）；onImportPage：是不是已经在 AI 导入页 */
function setup(layersOpen = false, onImportPage = false) {
  const replies: ShareReply[] = [],
    opened: string[] = [],
    notices: string[] = [],
    tones: NoticeTone[] = [];
  let open = layersOpen,
    whenClosed: (() => void) | null = null;
  const share = createAppShare({
    importPage: { shown: () => onImportPage, open: () => opened.push('AI 导入') },
    layers: {
      open: () => open,
      whenClosed: (fn) => {
        whenClosed = fn;
        return () => {
          whenClosed = null;
        };
      },
    },
    notify: (message, tone) => {
      notices.push(message);
      tones.push(tone);
    },
  });
  const send = (reply: ShareReply) => replies.push(reply);
  const closeLayers = () => {
    open = false;
    whenClosed?.();
  };
  return { share, send, replies, opened, notices, tones, closeLayers };
}

/** 假的导入页：收到的文件记下，结果由测试决定 */
function page(results: UploadReport[] = []) {
  const files: File[] = [];
  return {
    files,
    receiver: (file: File, report: (r: UploadReport) => void) => {
      files.push(file);
      report(results[files.length - 1] ?? { duplicate: false });
    },
  };
}

test('还没登录时收到分享先不跳页、不回话；登录后能进 AI 导入就打开导入页，页面就绪才回 share-ready', () => {
  const { share, send, replies, opened } = setup();
  assert.equal(share.receive(offer('s1', ['订单.pdf']), send), true);
  assert.deepEqual([opened, replies], [[], []]);
  share.account(true);
  assert.deepEqual([opened, replies], [['AI 导入'], []]);
  share.attach(page().receiver);
  assert.deepEqual(replies, [{ type: 'share-ready', shareId: 's1' }]);
});

test('进不了 AI 导入的账号收到分享回 share-rejected 带原因，不跳页，之后页面就绪也不再回 share-ready', () => {
  const { share, send, replies, opened } = setup();
  share.account(false);
  share.receive(offer('s2', ['a.pdf']), send);
  share.attach(page().receiver);
  assert.deepEqual(opened, []);
  assert.deepEqual(replies, [{ type: 'share-rejected', shareId: 's2', message: '当前账号不能使用 AI 导入，分享的文件没有上传' }]);
});

test('开着窗口时收到分享先提示、不跳页，窗口都关了再跳到 AI 导入，提示换成正在传', () => {
  const { share, send, opened, notices, closeLayers } = setup(true);
  share.account(true);
  share.receive(offer('s3', ['a.pdf', 'b.pdf']), send);
  assert.deepEqual(opened, []);
  assert.deepEqual(notices, ['收到 2 份分享的文件，关掉当前窗口后进入 AI 导入']);
  closeLayers();
  assert.deepEqual(opened, ['AI 导入']);
  assert.equal(notices.at(-1), '正在把分享的 2 份文件传进 AI 导入');
});

test('等窗口关掉时来了新的分享：只跳一次，就绪后回新编号的 share-ready', () => {
  const { share, send, replies, opened, closeLayers } = setup(true);
  share.account(true);
  share.receive(offer('old', ['a.pdf']), send);
  share.receive(offer('new', ['b.pdf']), send);
  closeLayers();
  share.attach(page().receiver);
  assert.deepEqual(opened, ['AI 导入']);
  assert.deepEqual(replies, [{ type: 'share-ready', shareId: 'new' }]);
});

test('每份按清单的名字和类型交给上传，逐份回结果，没有收尾消息', async () => {
  const { share, send, replies } = setup();
  const p = page([{ duplicate: true }, { error: TOO_LARGE }]);
  share.account(true);
  share.attach(p.receiver);
  share.receive(offer('s4', ['a.pdf', 'b.pdf']), send);
  share.receive(part('s4', 0, 'abc'), send);
  share.receive(part('s4', 1, 'xyz'), send);
  assert.equal(p.files[0]?.name, 'a.pdf');
  assert.equal(p.files[0]?.type, 'application/pdf');
  assert.equal(await p.files[1]?.text(), 'xyz');
  assert.deepEqual(replies, [
    { type: 'share-ready', shareId: 's4' },
    { type: 'share-uploaded', shareId: 's4', index: 0, duplicate: true },
    { type: 'share-failed', shareId: 's4', index: 1, message: TOO_LARGE },
  ]);
});

test('认不得的文件一律回 share-failed，编号和序号照抄收到的', () => {
  const { share, send, replies } = setup();
  const p = page();
  share.account(true);
  const detach = share.attach(p.receiver);
  share.receive(offer('s5', ['a.pdf']), send);
  share.receive(part('other', 0, 'abc'), send);
  share.receive(part('s5', 3, 'abc'), send);
  share.receive({ ...part('s5', 0, ''), data: '不是 base64' }, send);
  detach();
  share.receive(part('s5', 0, 'abc'), send);
  assert.equal(p.files.length, 0);
  assert.deepEqual(replies.slice(1), [
    { type: 'share-failed', shareId: 'other', index: 0, message: '这份文件不属于正在接收的这批分享，没有上传' },
    { type: 'share-failed', shareId: 's5', index: 3, message: '这份文件不在分享清单里，没有上传' },
    { type: 'share-failed', shareId: 's5', index: 0, message: '文件内容读不出来，没有上传' },
    { type: 'share-failed', shareId: 's5', index: 0, message: 'AI 导入页已关闭，这份没有上传' },
  ]);
});

test('清单里超过上限（10MB）的一份不解码、不上传，直接回 share-failed；正好 10MB 的照收', () => {
  const { share, send, replies } = setup();
  const p = page();
  share.account(true);
  share.attach(p.receiver);
  share.receive(offer('s6', ['大.pdf'], MAX_FILE_BYTES + 1), send);
  // 内容故意不是 base64：真去解码会报“读不出来”，报的是超上限说明没解码
  share.receive({ ...part('s6', 0, ''), data: '不是 base64' }, send);
  assert.deepEqual(replies.at(-1), { type: 'share-failed', shareId: 's6', index: 0, message: TOO_LARGE });
  share.receive(offer('s7', ['刚好.pdf'], MAX_FILE_BYTES), send);
  share.receive(part('s7', 0, 'abc'), send);
  assert.equal(p.files.length, 1);
});

test('不是分享消息或多了、少了字段时不认', () => {
  const { share, send, replies } = setup();
  assert.equal(share.receive({ type: 'back', id: 1 }, send), false);
  assert.equal(share.receive({ ...offer('s8', ['a.pdf']), extra: 1 }, send), false);
  assert.equal(share.receive({ type: 'share-offer', shareId: 's8', files: [] }, send), false);
  assert.equal(share.receive('{"type":"share-offer"}', send), false);
  assert.deepEqual(replies, []);
});

test('已经在 AI 导入页（工作区还没读好）时收到分享不提示、不再跳页，读好了回 share-ready', () => {
  const { share, send, replies, opened, notices } = setup(true, true);
  share.account(true);
  share.receive(offer('s9', ['a.pdf']), send);
  assert.deepEqual([opened, notices, replies], [[], [], []]);
  share.attach(page().receiver);
  assert.deepEqual(replies, [{ type: 'share-ready', shareId: 's9' }]);
});

test('还没回 share-ready 时来的文件回 share-failed（AI 导入页还没准备好）', () => {
  const { share, send, replies } = setup(true);
  share.account(true);
  share.receive(offer('s10', ['a.pdf']), send);
  share.receive(part('s10', 0, 'abc'), send);
  assert.deepEqual(replies, [{ type: 'share-failed', shareId: 's10', index: 0, message: NOT_READY }]);
});

test('格式不对的 share-file 也回 share-failed，编号、序号照抄；连编号、序号都认不出的不认', () => {
  const { share, send, replies } = setup();
  share.account(true);
  share.attach(page().receiver);
  share.receive(offer('s11', ['a.pdf']), send);
  share.receive({ ...part('s11', 0, 'abc'), extra: 1 }, send);
  share.receive({ ...part('s11', -1, 'abc') }, send);
  share.receive({ ...part('s11', 0, ''), data: 42 }, send);
  const malformed = '分享消息的格式不对，这份没有上传';
  assert.deepEqual(replies.slice(1), [
    { type: 'share-failed', shareId: 's11', index: 0, message: malformed },
    { type: 'share-failed', shareId: 's11', index: -1, message: malformed },
    { type: 'share-failed', shareId: 's11', index: 0, message: malformed },
  ]);
  assert.equal(share.receive({ type: 'share-file', shareId: 's11', data: 'AA==' }, send), false);
});

test('这批每份都有了结果，页面提示换成总结：都传上了说已传进，有没传上的说几份和头一个原因', () => {
  const { share, send, notices, tones } = setup();
  share.account(true);
  share.attach(page([{ duplicate: false }, { error: '网络断了' }]).receiver);
  share.receive(offer('s12', ['a.pdf', 'b.pdf']), send);
  share.receive(part('s12', 0, 'abc'), send);
  assert.deepEqual(notices, [], '还差一份时不说');
  share.receive(part('s12', 1, 'xyz'), send);
  assert.deepEqual([notices.at(-1), tones.at(-1)], ['分享的 2 份文件有 1 份没传进 AI 导入：网络断了', 'error']);
  share.receive(offer('s13', ['c.pdf']), send);
  share.receive(part('s13', 0, 'abc'), send);
  assert.deepEqual([notices.at(-1), tones.at(-1)], ['分享的 1 份文件已传进 AI 导入', 'done']);
});

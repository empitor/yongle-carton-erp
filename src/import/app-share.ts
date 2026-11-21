import { useEffect, useRef } from 'react';
import { z } from 'zod';
import { afterBackLayersClosed, hasBackLayer, notify, type NoticeTone } from '../ui/index';
import { MAX_FILE_BYTES, NOT_READY, TOO_LARGE, type UploadReport } from './useUploadQueue';

/*
 * 安卓 App 分享进来的文件（只在安卓 App 里有；通道在 src/app-bridge.ts，消息约定见 docs/架构/外壳和网页.md“安卓 App 通道”）：
 * App 先发 share-offer（编号和文件清单）。还没登录就等登录完；这个账号进不了 AI 导入回 share-rejected；
 * 能进就跳到 AI 导入页（开着窗口时先提示、等窗口都关了再跳），页面读好工作区（能上传了）回 share-ready。
 * App 再一份一份发 share-file，每份走 AI 导入现有的上传（服务端按内容去重、只存原件不识别），每一条都回结果；
 * 这批每份都有了结果，页面提示换成总结（传进了几份，没传上的几份、头一个原因）。
 * 一批办没办完由 App 自己数；页面中途重新加载后 App 会从第一份重发，服务端按内容认出同一份，不会多出任务。
 */

const shareFile = z.object({ name: z.string().min(1), mime: z.string(), size: z.number().int().min(0) }).strict();
const offerMessage = z
  .object({ type: z.literal('share-offer'), shareId: z.string().min(1), files: z.array(shareFile).min(1) })
  .strict();
/** share-file 先只认出编号和序号（回话照抄用）：其余核不过也要回 share-failed，不能不回话 */
const fileHead = z.object({ type: z.literal('share-file'), shareId: z.string(), index: z.number() });
const fileMessage = z
  .object({ type: z.literal('share-file'), shareId: z.string().min(1), index: z.number().int().min(0), data: z.string() })
  .strict();
type Offer = z.infer<typeof offerMessage>;
type FileHead = z.infer<typeof fileHead>;

/** 回给 App 的话 */
export type ShareReply =
  | { type: 'share-ready'; shareId: string }
  | { type: 'share-rejected'; shareId: string; message: string }
  | { type: 'share-uploaded'; shareId: string; index: number; duplicate: boolean }
  | { type: 'share-failed'; shareId: string; index: number; message: string };
type Send = (reply: ShareReply) => void;

/** AI 导入页交来的上传函数 */
type Receiver = (file: File, report: (result: UploadReport) => void) => void;

/** 正在收的这批：回话发给谁、回过 share-ready 没有、每份的结果（按序号） */
type Pending = Offer & { send: Send; ready: boolean; results: Map<number, UploadReport> };

const REJECTED = '当前账号不能使用 AI 导入，分享的文件没有上传';
const PAGE_CLOSED = 'AI 导入页已关闭，这份没有上传';
const OTHER_BATCH = '这份文件不属于正在接收的这批分享，没有上传';
const NOT_LISTED = '这份文件不在分享清单里，没有上传';
const UNREADABLE = '文件内容读不出来，没有上传';
const MALFORMED = '分享消息的格式不对，这份没有上传';
const waitForLayers = (count: number) => `收到 ${count} 份分享的文件，关掉当前窗口后进入 AI 导入`;
/** 跳到 AI 导入时说的（换掉上面那句等窗口的提醒） */
const moving = (count: number) => `正在把分享的 ${count} 份文件传进 AI 导入`;

/** base64 → 字节，逐字节写（Uint8Array.from(字符串) 会先把每个字符收进临时数组，大文件要多吃几百 MB）；不是合法 base64 返回 null */
function decodeBase64(data: string): Uint8Array<ArrayBuffer> | null {
  let text: string;
  try {
    text = atob(data);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** 这批的第 index 份有了结果：记下；每份都有结果了交出给人看的总结（有没传上的说几份、头一个原因），还没齐交出 null */
function settleBatch(batch: Pending, index: number, result: UploadReport): { message: string; tone: NoticeTone } | null {
  if (!Number.isInteger(index) || index < 0 || index >= batch.files.length) return null;
  batch.results.set(index, result);
  if (batch.results.size < batch.files.length) return null;
  const count = batch.files.length,
    errors = [...batch.results.values()].flatMap((r) => ('error' in r ? [r.error] : []));
  return errors.length
    ? { message: `分享的 ${count} 份文件有 ${errors.length} 份没传进 AI 导入：${errors[0]}`, tone: 'error' }
    : { message: `分享的 ${count} 份文件已传进 AI 导入`, tone: 'done' };
}

/** 认得这一份就交出文件，认不得交出原因（超过上限的不解码）。current 是正在收的这批，receiving 是导入页还开着 */
function take(raw: unknown, current: Pending | null, receiving: boolean): { file: File } | { error: string } {
  const parsed = fileMessage.safeParse(raw);
  if (!parsed.success) return { error: MALFORMED };
  const part = parsed.data;
  if (current?.shareId !== part.shareId) return { error: OTHER_BATCH };
  const meta = current.files[part.index];
  if (!meta) return { error: NOT_LISTED };
  if (!current.ready) return { error: NOT_READY };
  if (!receiving) return { error: PAGE_CLOSED };
  if (meta.size > MAX_FILE_BYTES) return { error: TOO_LARGE };
  const bytes = decodeBase64(part.data);
  return bytes ? { file: new File([bytes], meta.name, { type: meta.mime }) } : { error: UNREADABLE };
}

/**
 * 一个分享收件处。importPage 看是不是已在 AI 导入页、打开它；layers 看有没有开着的弹层、等它们关掉；notify 发页面提醒。
 * receive 收 App 的分享消息（不认识的返回 false）；attach 由能上传了的导入页调，返回撤销函数；
 * account 由登录后的外壳告诉这个账号能不能进 AI 导入（null 是没登录，等登录完再判断）。
 */
export function createAppShare(deps: {
  importPage: { shown: () => boolean; open: () => void };
  layers: { open: () => boolean; whenClosed: (fn: () => void) => () => void };
  notify: (message: string, tone: NoticeTone) => void;
}) {
  let pending: Pending | null = null,
    receiver: Receiver | null = null,
    allowed: boolean | null = null,
    stopWaiting: (() => void) | null = null;
  /** 往下走一步：判账号 → 页面就绪就回 share-ready → 已在导入页就等它读好 → 否则跳到导入页（有弹层先提示、等关掉） */
  const proceed = () => {
    const current = pending;
    if (!current || current.ready || allowed === null) return;
    if (!allowed) {
      pending = null;
      current.send({ type: 'share-rejected', shareId: current.shareId, message: REJECTED });
    } else if (receiver) {
      current.ready = true;
      current.send({ type: 'share-ready', shareId: current.shareId });
    } else if (stopWaiting || deps.importPage.shown()) {
      return;
    } else if (deps.layers.open()) {
      deps.notify(waitForLayers(current.files.length), 'info');
      stopWaiting = deps.layers.whenClosed(() => {
        stopWaiting = null;
        proceed();
      });
    } else {
      deps.importPage.open();
      deps.notify(moving(current.files.length), 'info');
    }
  };
  const offer = (message: Offer, send: Send) => {
    stopWaiting?.();
    stopWaiting = null;
    pending = { ...message, send, ready: false, results: new Map() };
    proceed();
  };
  /** 每一份都回结果，编号、序号照抄收到的；这批每份都有结果了，页面提示换成总结 */
  const receiveFile = ({ shareId, index }: FileHead, raw: unknown, send: Send) => {
    const batch = pending?.shareId === shareId ? pending : null;
    const report = (result: UploadReport) => {
      send(
        'error' in result
          ? { type: 'share-failed', shareId, index, message: result.error }
          : { type: 'share-uploaded', shareId, index, duplicate: result.duplicate },
      );
      const summary = batch && pending === batch ? settleBatch(batch, index, result) : null;
      if (summary) deps.notify(summary.message, summary.tone);
    };
    const taken = take(raw, pending, !!receiver);
    if ('error' in taken) report(taken);
    else receiver?.(taken.file, report);
  };
  return {
    receive(raw: unknown, send: Send): boolean {
      const offered = offerMessage.safeParse(raw);
      if (offered.success) offer(offered.data, send);
      else {
        const head = fileHead.safeParse(raw);
        if (!head.success) return false;
        receiveFile(head.data, raw, send);
      }
      return true;
    },
    attach(next: Receiver) {
      receiver = next;
      proceed();
      return () => {
        if (receiver === next) receiver = null;
      };
    },
    account(next: boolean | null) {
      allowed = next;
      proceed();
    },
  };
}

const IMPORT_PAGE = '#ai-import';
const appShare = createAppShare({
  importPage: {
    shown: () => location.hash.startsWith(IMPORT_PAGE),
    open: () => {
      location.hash = IMPORT_PAGE;
    },
  },
  layers: { open: hasBackLayer, whenClosed: afterBackLayersClosed },
  notify,
});

/** 通道转来的分享消息；不是分享消息返回 false */
export const receiveAppShare = appShare.receive;

/** 登录后的外壳：这个账号能不能进 AI 导入（卸下时按没登录处理） */
export function useAppShareAccount(allowed: boolean) {
  useEffect(() => {
    appShare.account(allowed);
    return () => appShare.account(null);
  }, [allowed]);
}

/** AI 导入页：ready（工作区读好了、能上传）时接 App 分享来的文件，走同一个上传 */
export function useAppShare(ready: boolean, upload: (files: File[], report: (result: UploadReport) => void) => void) {
  const latest = useRef(upload);
  useEffect(() => {
    latest.current = upload;
  });
  useEffect(() => (ready ? appShare.attach((file, report) => latest.current([file], report)) : undefined), [ready]);
}

import { z } from 'zod';
import { isPageHref, pageHref } from '../../shared/core/index';
import {
  pageObserveSchema,
  pageResultBody,
  type PageObserveOptions,
  type PageSnapshot,
} from '../../shared/assistant/index';
import { sendPageResult } from './assistant-api';

/**
 * 看用户眼前的页面，交给助手：标题、正文、表格、弹窗、提示、选中的项、当前打开的记录。只看不动。
 * 不采集输入框里的字、密码和密钥区域、助手窗口自己；不接收选择器、脚本或网络命令。
 */
const excluded =
  '.global-assistant,.oi-account,.auth-form,.ai-secret-input,[data-agent-private],script,style,iframe,object,embed,svg';
/** 一次快照交回去最多多少字（服务器收 160000 以内） */
const SNAPSHOT_MAX_CHARS = 100000;
const compact = (s: string | null | undefined, n = 300) =>
  (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const visible = (e: Element) =>
  !e.closest(excluded + ',[hidden],[aria-hidden="true"]') &&
  e.getClientRects().length > 0 &&
  getComputedStyle(e).visibility !== 'hidden' &&
  getComputedStyle(e).display !== 'none';
const shown = <T extends Element>(selector: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(selector)).filter(visible);

function safeText(root: Element, n = 16000): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = '',
    node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || !visible(parent) || parent.closest('input,textarea,select,option') || parent.closest('[data-agent-private]'))
      continue;
    text += ' ' + (node.textContent || '');
    if (text.length >= n * 2) break;
  }
  return compact(text, n);
}

const regionSelectors = {
  main: 'main',
  dialog: '[role="dialog"],dialog[open]',
  navigation: 'aside nav',
  form: 'form',
  table: 'table',
};
/** 各种看法最多带回多少字正文 */
const textLimits = { summary: 1200, region: 4000, record: 8000, full: 16000 };

/** 这次看哪一块：概要看最上面的弹窗（没有就看主区域），记录看当前打开的那条，区域按名字找 */
function observedRoot(options: ReturnType<typeof pageObserveSchema.parse>, dialogs: HTMLElement[], record: HTMLElement | undefined): Element {
  const main: Element = document.querySelector('main') || document.body;
  if (options.mode === 'full') return document.body;
  if (options.mode === 'summary') return dialogs.at(-1) || main;
  if (options.mode === 'record') {
    if (
      !record ||
      (options.record &&
        (record.dataset.agentModule !== options.record.module || Number(record.dataset.agentRecord) !== options.record.id))
    )
      throw Error('指定的记录不是当前打开的记录；要它的数据请直接查记录。');
    return record.closest('[role="dialog"],dialog') || dialogs.at(-1) || record;
  }
  const regions = shown(regionSelectors[options.region || 'main']);
  const chosen = regions.at(options.region === 'dialog' ? -1 : options.region === 'table' ? options.tableIndex : 0);
  if (!chosen) throw Error('指定的区域现在不在页面上。');
  return chosen;
}

export function observeErpPage(raw: PageObserveOptions = {}): PageSnapshot {
  const options = pageObserveSchema.parse(raw);
  const dialogs = shown<HTMLElement>('[role="dialog"],dialog[open]');
  const record = shown<HTMLElement>('[data-agent-module][data-agent-record]').at(-1);
  const root = observedRoot(options, dialogs, record);
  const isTable = root instanceof HTMLTableElement;
  const tables = isTable ? [root] : shown<HTMLTableElement>('table', root);
  const first = isTable ? 0 : options.tableIndex;
  const chosenTables = tables.slice(first, first + (options.mode === 'full' ? 5 : 1));
  const rowLimit = options.limit ?? (options.mode === 'full' ? 32 : 5);
  const textLimit = textLimits[options.mode];
  const result: PageSnapshot = {
    route: isPageHref(location.hash) ? location.hash : pageHref('dashboard'),
    capturedAt: new Date().toISOString(),
    title: compact(
      shown('h1,h2')
        .map((e) => e.textContent)
        .join(' / '),
    ),
    mode: options.mode,
    // 概要只带标题和提示，别的看法带这一块的正文
    text:
      options.mode === 'summary'
        ? compact(
            shown('h1,h2,h3,[role="alert"],[role="status"]', root)
              .map((e) => safeText(e, 300))
              .join(' / '),
            textLimit,
          )
        : safeText(root, textLimit),
    tables: chosenTables.map((t) =>
      Array.from(t.rows)
        .slice(options.offset, options.offset + rowLimit)
        .map((r) =>
          Array.from(r.cells)
            .slice(0, 24)
            .map((c) => safeText(c, 400)),
        ),
    ),
    tablesPage: chosenTables.map((t, i) => ({
      index: options.tableIndex + i,
      totalRows: t.rows.length,
      offset: options.offset,
      limit: rowLimit,
      hasMore: options.offset + rowLimit < t.rows.length,
    })),
    selected: shown('[aria-current],[aria-selected="true"],.nav-item.selected,.nav-subitem.selected')
      .slice(0, 60)
      .map((e) => compact(e.textContent)),
    dialogs: dialogs.slice(0, 12).map((e) => compact(e.getAttribute('aria-label') || safeText(e, 500), 500)),
    feedback: shown('[role="alert"],[role="status"],.local-notice,.notice,.operation-error')
      .slice(0, 12)
      .map((e) => safeText(e, 1000)),
    truncated:
      chosenTables.some((t) => t.rows.length > options.offset + rowLimit) || safeText(root, textLimit + 1).length > textLimit,
  };
  // 记录是按 [data-agent-module] 找出来的，模块名一定在
  const recordModule = record?.dataset.agentModule;
  if (record && recordModule !== undefined && Number(record.dataset.agentRecord) > 0)
    result.record = {
      module: recordModule,
      id: Number(record.dataset.agentRecord),
      label: compact(record.dataset.agentLabel),
    };
  // 大表超过交回的上限：从最后一张表的末尾往前减
  while (JSON.stringify(result).length > SNAPSHOT_MAX_CHARS) {
    result.truncated = true;
    const table = result.tables.at(-1);
    if (table?.length) table.pop();
    else if (result.tables.length) result.tables.pop();
    else break;
  }
  return result;
}

/**
 * 服务器发来的“看一眼页面”命令（server/assistant/page-bridge.ts 发的 page_command）。
 * 看法（observe）放到看页面时再认：看法不对要照旧作为“没看成”交回服务器，不让它干等。
 */
const pageCommandSchema = pageResultBody
  .omit({ result: true })
  .extend({ observe: z.unknown().optional() });

function readPageCommand(raw: unknown) {
  const parsed = pageCommandSchema.safeParse(raw);
  if (!parsed.success) throw new Error('服务器发来的“看一眼页面”命令内容对不上，这次没看页面。');
  return parsed.data;
}

/** 服务器经聊天的事件流发来“看一眼页面”：看完把快照交回去（只认这个页面、这个账号的命令） */
export async function executePageCommand(
  raw: unknown,
  clientId: string,
  owner: string,
  currentOwner: () => string | undefined,
) {
  const command = readPageCommand(raw);
  if (command.clientId !== clientId || currentOwner() !== owner) return;
  let result;
  try {
    const observe = pageObserveSchema.parse(command.observe ?? {});
    result = { ok: true, message: '已读取当前页面', snapshot: observeErpPage(observe) };
  } catch (e) {
    result = { ok: false, message: e instanceof Error ? e.message : '页面读取失败' };
  }
  if (currentOwner() === owner)
    await sendPageResult({
      commandId: command.commandId,
      clientId: command.clientId,
      threadId: command.threadId,
      requestId: command.requestId,
      result,
    });
}

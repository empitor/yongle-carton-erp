import { pageSnapshotDelta } from '../shared/page-observation';
import {
  pageActionSchema,
  pageObserveSchema,
  type PageObserveOptions,
  type PageAction,
  type PageSnapshot,
} from '../shared/assistant-page';
import { isErpNavigation } from '../shared/assistant-navigation';
// 只保留当前快照的控件引用；不接收选择器、脚本或网络命令。
const excluded =
  '.global-assistant,.oi-account,.auth-form,.ai-secret-input,[data-agent-private],script,style,iframe,object,embed,svg';
const secretName = /password|passwd|api.?key|token|cookie|secret|密码|密钥|口令/i;
const compact = (s: string | null | undefined, n = 300) =>
  (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const visible = (e: Element) =>
  !e.closest(excluded + ',[hidden],[aria-hidden="true"]') &&
  e.getClientRects().length > 0 &&
  getComputedStyle(e).visibility !== 'hidden' &&
  getComputedStyle(e).display !== 'none';
let current:
  | {
      id: string;
      route: string;
      signature: string;
      controls: Map<string, HTMLElement>;
      snapshot: PageSnapshot;
      options: PageObserveOptions;
    }
  | undefined;
let elementSequence = 0;
const elementIds = new WeakMap<Element, string>();
const elementId = (e: Element) => {
  let id = elementIds.get(e);
  if (!id) {
    id = 'e' + ++elementSequence;
    elementIds.set(e, id);
  }
  return id;
};
function safeText(root: Element, n = 16000): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = '',
    node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (
      !parent ||
      !visible(parent) ||
      parent.closest('input,textarea,select,option') ||
      parent.closest('[data-agent-private]')
    )
      continue;
    text += ' ' + (node.textContent || '');
    if (text.length >= n * 2) break;
  }
  return compact(text, n);
}
function name(e: HTMLElement) {
  const labelled = e
    .getAttribute('aria-labelledby')
    ?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent || '')
    .join(' ');
  const labels =
    'labels' in e
      ? Array.from((e as HTMLInputElement).labels || [])
          .map((l) => l.textContent)
          .join(' ')
      : '';
  return compact(
    e.getAttribute('aria-label') ||
      labelled ||
      labels ||
      e.getAttribute('placeholder') ||
      e.getAttribute('title') ||
      e.textContent ||
      e.getAttribute('name'),
  );
}
function candidates() {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      'button,a[href^="#"],input,textarea,select,summary,[role="button"],[role="tab"],form,[data-agent-scroll],main,.table-wrap,.table-region',
    ),
  )
    .filter(visible)
    .filter(
      (e) =>
        !secretName.test(
          [name(e), e.getAttribute('name'), e.getAttribute('autocomplete')].join(' '),
        ) && !(e instanceof HTMLInputElement && ['password', 'hidden', 'file'].includes(e.type)),
    );
}
function signature() {
  return (
    candidates()
      .map((e) =>
        [
          e.tagName,
          name(e),
          e instanceof HTMLInputElement ||
          e instanceof HTMLTextAreaElement ||
          e instanceof HTMLSelectElement
            ? e.value
            : '',
          e instanceof HTMLInputElement ? e.checked : '',
          e.getAttribute('disabled'),
          e.getAttribute('aria-selected'),
        ].join('|'),
      )
      .join('\n') + safeText(document.body, 18000)
  );
}
export function observeErpPage(raw: PageObserveOptions = {}): PageSnapshot {
  const options = pageObserveSchema.parse(raw),
    previous = current;
  const visibleDialogs = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"],dialog[open]'),
  ).filter(visible);
  const record = Array.from(
    document.querySelectorAll<HTMLElement>('[data-agent-module][data-agent-record]'),
  )
    .filter(visible)
    .at(-1);
  let root: Element = document.querySelector('main') || document.body;
  if (options.mode === 'full') root = document.body;
  else if (options.mode === 'summary') root = visibleDialogs.at(-1) || root;
  else if (options.mode === 'record') {
    if (
      !record ||
      (options.record &&
        (record.dataset.agentModule !== options.record.module ||
          Number(record.dataset.agentRecord) !== options.record.id))
    )
      throw Error('指定记录不是当前打开的记录，请使用records.get读取或先打开该记录。');
    root = record.closest('[role="dialog"],dialog') || visibleDialogs.at(-1) || record;
  } else if (options.mode === 'region') {
    if (options.target) {
      if (!current || options.snapshotId !== current.id || current.signature !== signature())
        throw Error('区域引用已失效，请重新观察。');
      const target = current.controls.get(options.target);
      if (!target || !visible(target)) throw Error('区域不可见。');
      root = target;
    } else {
      const selector = {
        main: 'main',
        dialog: '[role="dialog"],dialog[open]',
        navigation: 'aside nav',
        form: 'form',
        table: 'table',
      }[options.region || 'main'];
      const regions = Array.from(document.querySelectorAll(selector)).filter(visible);
      const chosen = regions.at(
        options.region === 'dialog' ? -1 : options.region === 'table' ? options.tableIndex : 0,
      );
      if (!chosen) throw Error('指定区域当前不可见。');
      root = chosen;
    }
  }
  const allElements = candidates().filter(
    (e) => root === document.body || root === e || root.contains(e),
  );
  const elements = allElements.slice(
    options.controlOffset,
    options.controlOffset + (options.mode === 'full' ? 180 : 60),
  );
  const controls = new Map<string, HTMLElement>();
  const route = isErpNavigation(location.hash) ? location.hash : '#dashboard';
  const tables = (
    root.matches('table')
      ? [root as HTMLTableElement]
      : Array.from(root.querySelectorAll('table')).filter(visible)
  ) as HTMLTableElement[];
  const chosenTables =
    options.mode === 'full'
      ? tables.slice(options.tableIndex, options.tableIndex + 5)
      : tables.slice(
          root.matches('table') ? 0 : options.tableIndex,
          (root.matches('table') ? 0 : options.tableIndex) + 1,
        );
  const rowLimit = options.limit ?? (options.mode === 'full' ? 32 : 5);
  const textLimit =
    options.mode === 'summary'
      ? 1200
      : options.mode === 'full'
        ? 16000
        : options.mode === 'record'
          ? 8000
          : 4000;
  const displayText =
    options.mode === 'summary'
      ? compact(
          Array.from(root.querySelectorAll('h1,h2,h3,[role="alert"],[role="status"]'))
            .filter(visible)
            .map((e) => safeText(e, 300))
            .join(' / '),
          textLimit,
        )
      : safeText(root, textLimit);
  const result: PageSnapshot = {
    snapshotId: crypto.randomUUID(),
    route,
    capturedAt: new Date().toISOString(),
    title: compact(
      Array.from(document.querySelectorAll('h1,h2'))
        .filter(visible)
        .map((e) => e.textContent)
        .join(' / '),
    ),
    mode: options.mode,
    text: displayText,
    controls: elements.map((e) => {
      const id = elementId(e);
      controls.set(id, e);
      const value =
        e instanceof HTMLInputElement ||
        e instanceof HTMLTextAreaElement ||
        e instanceof HTMLSelectElement
          ? compact(e.value, 1200)
          : undefined;
      return {
        id,
        role: e.getAttribute('role') || e.tagName.toLowerCase(),
        name: name(e),
        value,
        disabled: e.matches(':disabled') || e.getAttribute('aria-disabled') === 'true',
        ...(e instanceof HTMLSelectElement
          ? {
              optionsTotal: e.options.length,
              options: [
                ...Array.from(e.options).slice(
                  options.optionOffset,
                  options.optionOffset + (options.mode === 'summary' ? 7 : 79),
                ),
                ...Array.from(e.selectedOptions).filter(
                  (o) =>
                    !Array.from(e.options)
                      .slice(
                        options.optionOffset,
                        options.optionOffset + (options.mode === 'summary' ? 7 : 79),
                      )
                      .includes(o),
                ),
              ]
                .slice(0, 80)
                .map((o) => ({ value: compact(o.value), label: compact(o.text) })),
            }
          : {}),
      };
    }),
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
    selected: Array.from(
      document.querySelectorAll(
        '[aria-current],[aria-selected="true"],input:checked,.nav-item.selected,.nav-subitem.selected',
      ),
    )
      .filter(visible)
      .slice(0, 60)
      .map((e) => compact(e instanceof HTMLInputElement ? name(e) : e.textContent)),
    dialogs: Array.from(document.querySelectorAll('[role="dialog"],dialog[open]'))
      .filter(visible)
      .slice(0, 12)
      .map((e) => compact(e.getAttribute('aria-label') || safeText(e, 500), 500)),
    feedback: Array.from(
      document.querySelectorAll(
        '[role="alert"],[role="status"],.local-notice,.notice,.operation-error',
      ),
    )
      .filter(visible)
      .slice(0, 12)
      .map((e) => safeText(e, 1000)),
    truncated:
      allElements.length > options.controlOffset + elements.length ||
      elements.some(
        (e) =>
          e instanceof HTMLSelectElement &&
          e.options.length > options.optionOffset + (options.mode === 'summary' ? 8 : 80),
      ) ||
      chosenTables.some((t) => t.rows.length > options.offset + rowLimit) ||
      safeText(root, textLimit + 1).length > textLimit,
  };
  if (record && Number(record.dataset.agentRecord) > 0)
    result.record = {
      module: record.dataset.agentModule!,
      id: Number(record.dataset.agentRecord),
      label: compact(record.dataset.agentLabel),
    };
  // 总预算避免大表/长选项超过反馈上限；未回传控件不可被猜编号操作。
  while (JSON.stringify(result).length > 100000) {
    result.truncated = true;
    const table = result.tables.at(-1);
    if (table?.length) table.pop();
    else if (result.tables.length) result.tables.pop();
    else if (result.controls.length) controls.delete(result.controls.pop()!.id);
    else break;
  }
  current = {
    id: result.snapshotId,
    route: location.hash,
    signature: signature(),
    controls,
    snapshot: result,
    options,
  };
  return options.diff ? pageSnapshotDelta(result, previous?.snapshot) : result;
}
const settle = () =>
  new Promise<void>((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;
    const end = () => {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(limit);
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(end, 300);
    });
    const limit = setTimeout(end, 2500);
    quiet = setTimeout(end, 500);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });
export async function actOnErpPage(raw: unknown) {
  const a: PageAction = pageActionSchema.parse(raw);
  if (a.action === 'navigate') {
    location.hash = a.url;
    await settle();
    return observeErpPage({ diff: true });
  }
  if (
    !current ||
    a.snapshotId !== current.id ||
    current.route !== location.hash ||
    current.signature !== signature()
  )
    throw Error('页面已变化，请重新观察后使用新控件引用。');
  const e =
    'target' in a && a.target
      ? current.controls.get(a.target)
      : (document.scrollingElement as HTMLElement);
  if (
    !e ||
    !e.isConnected ||
    !visible(e) ||
    e.matches(':disabled') ||
    e.getAttribute('aria-disabled') === 'true'
  )
    throw Error('控件已移除、不可见或禁用，请重新观察。');
  if (a.action === 'click') e.click();
  else if (a.action === 'fill') {
    if (
      !(e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) ||
      e.readOnly ||
      (e instanceof HTMLInputElement &&
        ['password', 'file', 'hidden', 'checkbox', 'radio', 'button', 'submit'].includes(e.type))
    )
      throw Error('该控件不是可编辑的普通文本字段。');
    const setter = Object.getOwnPropertyDescriptor(
      e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(e, a.value);
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    e.blur();
  } else if (a.action === 'select') {
    if (
      !(e instanceof HTMLSelectElement) ||
      !Array.from(e.options).some((o) => o.value === a.value && !o.disabled)
    )
      throw Error('下拉选项不存在或禁用。');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(e, a.value);
    e.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (a.action === 'submit') {
    const form = e instanceof HTMLFormElement ? e : e.closest('form');
    if (!form || form.querySelector('input[type="password"],.ai-secret-input,[data-agent-private]'))
      throw Error('该表单无法通过页面桥接提交。');
    form.requestSubmit();
  } else if (a.action === 'scroll') e.scrollBy({ top: a.deltaY, behavior: 'instant' });
  else if (a.action === 'key') {
    e.focus();
    if (a.key === 'Enter' && e.matches('button,a,summary')) e.click();
    else if (a.key === 'Tab') {
      const list = candidates().filter((x) => x.tabIndex >= 0);
      list[(list.indexOf(e) + 1) % list.length]?.focus();
    } else e.dispatchEvent(new KeyboardEvent('keydown', { key: a.key, bubbles: true }));
  }
  const nextOptions = current.options;
  await settle();
  try {
    return observeErpPage({ ...nextOptions, target: undefined, snapshotId: undefined, diff: true });
  } catch {
    return observeErpPage({ diff: true });
  }
}
export async function executePageCommand(
  command: any,
  clientId: string,
  owner: string,
  currentOwner: () => string | undefined,
  reply: (url: string, body: unknown) => Promise<unknown>,
) {
  if (command.clientId !== clientId || currentOwner() !== owner) return;
  let result;
  try {
    const state: any = await reply('/assistant/tools', undefined);
    const tool = command.action ? 'page.act' : 'page.observe';
    if (!state.tools.some((t: any) => t.name === tool && t.enabled))
      throw Error('ERP页面插件或工具已停用。');
    if (currentOwner() !== owner) return;
    const snapshot = command.action
      ? await actOnErpPage(command.action)
      : observeErpPage(command.observe || {});
    result = {
      ok: true,
      message: command.action ? '已执行界面交互并重新读取页面反馈' : '已读取当前ERP页面',
      snapshot,
    };
  } catch (e) {
    result = { ok: false, message: e instanceof Error ? e.message : '页面操作失败' };
  }
  if (currentOwner() === owner)
    await reply('/assistant/page/results', {
      commandId: command.commandId,
      clientId: command.clientId,
      threadId: command.threadId,
      requestId: command.requestId,
      result,
    });
}

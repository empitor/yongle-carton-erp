import { z } from 'zod';

/**
 * 前端各模块之间互相通知只用这里的事件：事件名和带的数据都在下面登记，发用 emit，收用 listen。
 * 别处不直接写 dispatchEvent(new CustomEvent(...)) 或 addEventListener('erp-...')（tests/module-boundaries.test.ts 检查），
 * 这样改名、改数据时类型检查能找到所有发的和收的地方，不会一处漏改就悄悄失效。
 * 浏览器自带的事件（hashchange、focus、keydown 等）照常用 window.addEventListener。
 */
/** 底部提示的内容：只给文字是办成了；tone 为 error 是没办成（窗口已经关了，原因只能在这里说）。 */
export type NoticeDetail = string | { message: string; tone?: 'done' | 'error' };

/** 读底部提示带的内容；不认识的内容返回 null。 */
export function readNotice(detail: unknown): { message: string; tone: 'done' | 'error' } | null {
  if (typeof detail === 'string') return detail ? { message: detail, tone: 'done' } : null;
  if (typeof detail !== 'object' || detail === null) return null;
  const message: unknown = Reflect.get(detail, 'message');
  if (typeof message !== 'string' || !message) return null;
  return { message, tone: Reflect.get(detail, 'tone') === 'error' ? 'error' : 'done' };
}

export type AppEvents = {
  /** 业务数据变了（保存、删除、导入、助手执行后）：列表、今日页、详情重新读取 */
  'erp-business-changed': undefined;
  /** 页面底部提示一句话；办完的事由窗口关掉后在这里说结果，没办成的 tone 为 error 用红色 */
  'erp-notice': NoticeDetail;
  /** 登录状态变了（登录、退出、改密码、切换超级管理员模式） */
  'erp-auth-changed': undefined;
  /** 打开账号菜单里的“系统维护”窗口（页面上“进入超级管理员模式”的入口） */
  'erp-open-maintenance': undefined;
  /** 打开全局助手（顶栏、手机导航的助手按钮） */
  'erp-open-assistant': undefined;
  /** 右侧详情面板打开（面板标题）或关闭（null），助手据此知道用户正在看什么 */
  'erp-panel-focus': string | null;
  /** 告诉助手当前打开的是哪条记录，只发上下文，不做别的 */
  'erp-ai-record-context': { module: string; id: number; label: string };
  /** 助手处理了某个 AI 识别工作区，AI 导入页切过去并刷新 */
  'erp-ai-workspace-changed': { workspaceId: string };
  /** 助手增删了 AI 识别工作区，AI 导入页刷新列表 */
  'erp-ai-workspace-list-changed': undefined;
  /** 助手的入口位置（顶栏或悬浮）设置变了 */
  'erp-assistant-launcher-change': undefined;
  /** 页面套上了新的外观（本标签页切换、别的标签页改了、系统深浅变了），显示外观的地方重新读 */
  'erp-theme-changed': undefined;
};

/** 不带数据的事件：带了什么都不看 */
const none = () => undefined;
/** 带数据的事件：按结构认，对不上说清是哪个事件（只有不经 emit 自己派发的才会对不上） */
const shaped =
  <T>(name: keyof AppEvents, schema: z.ZodType<T>) =>
  (detail: unknown): T => {
    const parsed = schema.safeParse(detail);
    if (!parsed.success) throw new Error('页面事件 ' + name + ' 带的内容不对');
    return parsed.data;
  };
/** 每个事件怎么读带的数据。收到的是浏览器事件，带的数据只能当 unknown，按这里认出登记的类型 */
const readers: { [K in keyof AppEvents]: (detail: unknown) => AppEvents[K] } = {
  'erp-business-changed': none,
  // 不认识的提示交出空文字，收的地方用 readNotice 读到 null 就不显示（和直接交出原样内容时一样）
  'erp-notice': (detail) => readNotice(detail) ?? '',
  'erp-auth-changed': none,
  'erp-open-maintenance': none,
  'erp-open-assistant': none,
  'erp-panel-focus': shaped('erp-panel-focus', z.string().nullable()),
  'erp-ai-record-context': shaped('erp-ai-record-context', z.object({ module: z.string(), id: z.number(), label: z.string() })),
  'erp-ai-workspace-changed': shaped('erp-ai-workspace-changed', z.object({ workspaceId: z.string() })),
  'erp-ai-workspace-list-changed': none,
  'erp-assistant-launcher-change': none,
  'erp-theme-changed': none,
};

type Args<K extends keyof AppEvents> = [AppEvents[K]] extends [undefined] ? [] : [detail: AppEvents[K]];

/** 发一个事件。不带数据的事件只写名字。 */
export function emit<K extends keyof AppEvents>(name: K, ...args: Args<K>): void {
  window.dispatchEvent(args.length ? new CustomEvent(name, { detail: args[0] }) : new Event(name));
}

/** 页面底部提示一句话：办完了只给文字；窗口已经关掉、事情没办成时 tone 给 'error'（红色，停留久一些）。 */
export function notify(message: string, tone?: 'error'): void {
  emit('erp-notice', tone ? { message, tone } : message);
}

/** 收一个事件，返回取消收听的函数（在 useEffect 里直接 return 它）。 */
export function listen<K extends keyof AppEvents>(name: K, handler: (detail: AppEvents[K]) => void): () => void {
  const receive = (event: Event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
    handler(readers[name](detail));
  };
  window.addEventListener(name, receive);
  return () => window.removeEventListener(name, receive);
}

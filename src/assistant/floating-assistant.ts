import { z } from 'zod';
import { pageIdOf, pages, type PageId } from '../../shared/core/index';

export type FloatingPoint = { x: number; y: number };
export type FloatingSize = { width: number; height: number };
export type FloatingViewport = FloatingSize & { left: number; top: number };
export const floatingPositionKey = 'erp-assistant-position-v1';
export const mascotSize: FloatingSize = { width: 104, height: 108 };
/**
 * 压住详情面板时小人缩到屏幕右边只露出这么宽（详情面板往左让出同样宽），鼠标移上去、键盘聚焦时再往左探出 yieldReveal。
 * 组件把两个数设成页面上的 CSS 变量（--ga-yield-peek、--ga-yield-reveal），admin.css 的 ga-yield-over-panel 只读变量。
 */
export const yieldPeek = 14;
export const yieldReveal = 62;
/**
 * 压住按钮、表格时缩到左右边：组件把小人放到一半在屏幕外，admin.css 的 ga-yield-left / ga-yield-right
 * 再往外推 yieldTuck（translateX(±20px)），所以实际只露出 yieldVisible 宽。选边时按这一条算，不按半个身子算。
 */
export const yieldTuck = 20;
export const yieldVisible = mascotSize.width / 2 - yieldTuck;
export type YieldSide = 'left' | 'right';
type YieldRect = { left: number; top: number; width: number; height: number };
/** 缩到某一边以后屏幕上实际露出的那一条（top 跟着小人原来的高度）。 */
export function yieldStrip(side: YieldSide, rect: YieldRect, viewportWidth: number): YieldRect {
  return { ...rect, left: side === 'left' ? 0 : viewportWidth - yieldVisible, width: yieldVisible };
}
/**
 * 选缩向哪一边。每边给出缩过去以后那一条压住的点数（hits）和会不会压到左侧导航（nav）：
 * 会压到导航的一边不去（两边都压到导航时才比点数）；都不压导航时，近的那边压得不比另一边多就留在近的那边。
 */
export function chooseYieldSide(
  near: YieldSide,
  cost: Record<YieldSide, { hits: number; nav: boolean }>,
): YieldSide {
  const far: YieldSide = near === 'left' ? 'right' : 'left';
  if (cost[near].nav !== cost[far].nav) return cost[near].nav ? far : near;
  return cost[far].hits < cost[near].hits ? far : near;
}
export const dragThreshold = 6;
export const floatingLauncherModeKey = 'erp-assistant-launcher-mode-v1';
/** Only an explicitly saved topbar preference hides the mascot. Missing/old values stay usable. */
export function readFloatingLauncher(storage: Pick<Storage, 'getItem'>): boolean {
  try {
    return storage.getItem(floatingLauncherModeKey) !== 'docked';
  } catch {
    return true;
  }
}
export const assistantPanelModeKey = 'erp-assistant-panel-mode-v1';
export type AssistantPanelMode = 'docked' | 'floating';
/** 展开后默认停靠右侧并推开内容；只有明确选过才用浮动窗口。 */
export function readAssistantPanelMode(storage: Pick<Storage, 'getItem'>): AssistantPanelMode {
  try {
    return storage.getItem(assistantPanelModeKey) === 'floating' ? 'floating' : 'docked';
  } catch {
    return 'docked';
  }
}
/** 顶部显示当前页面和正在看的记录（页名从全站页面表派生，少数用更短的说法），说明助手回答时参考的上下文。 */
const assistantPageShort: Partial<Record<PageId, string>> = {
  purchases: '采购',
  production: '生产',
  finance: '财务',
  'finance-settings': '财务 · 设置',
};
export function assistantPageLabel(hash: string, record?: string | null) {
  const id = hash ? pageIdOf(hash) : 'dashboard';
  if (!id) return '';
  const meta = pages[id];
  const name = assistantPageShort[id] ?? (meta.group === '财务' ? '财务 · ' + meta.title : meta.title);
  return [name, record].filter(Boolean).join(' · ');
}
const margin = 8;
const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(n, Math.max(min, max)));
/** The shared anchor is the bottom-right corner: opening unfolds up/left from the spirit. */
export function defaultFloatingAnchor(v: FloatingViewport): FloatingPoint {
  return fitFloatingAnchor({ x: v.left + v.width - 24, y: v.top + v.height - 20 }, v);
}
export function fitFloatingAnchor(p: FloatingPoint, v: FloatingViewport): FloatingPoint {
  return {
    x: clamp(
      p.x,
      v.left + Math.min(Math.max(0, v.width - margin * 2), mascotSize.width) + margin,
      v.left + v.width - margin,
    ),
    y: clamp(
      p.y,
      v.top + Math.min(Math.max(0, v.height - margin * 2), mascotSize.height) + margin,
      v.top + v.height - margin,
    ),
  };
}
export function clampFloatingPosition(
  p: FloatingPoint,
  size: FloatingSize,
  v: FloatingViewport,
): FloatingPoint {
  return {
    x: clamp(p.x, v.left + margin, v.left + v.width - size.width - margin),
    y: clamp(p.y, v.top + margin, v.top + v.height - size.height - margin),
  };
}
export function floatingPosition(anchor: FloatingPoint, size: FloatingSize, v: FloatingViewport) {
  return clampFloatingPosition({ x: anchor.x - size.width, y: anchor.y - size.height }, size, v);
}
export function snapFloatingPosition(
  p: FloatingPoint,
  size: FloatingSize,
  v: FloatingViewport,
  distance = 16,
) {
  const c = clampFloatingPosition(p, size, v),
    left = v.left + margin,
    top = v.top + margin,
    right = Math.max(left, v.left + v.width - size.width - margin),
    bottom = Math.max(top, v.top + v.height - size.height - margin);
  const snap = (n: number, a: number, b: number) =>
    Math.min(n - a, b - n) <= distance ? (n - a <= b - n ? a : b) : n;
  return { x: snap(c.x, left, right), y: snap(c.y, top, bottom) };
}
export function isFloatingDrag(start: FloatingPoint, point: FloatingPoint) {
  return Math.hypot(point.x - start.x, point.y - start.y) >= dragThreshold;
}
/**
 * 读浏览器里记下的位置、大小：按结构认（z.number() 不收 NaN、无穷大），认不出就当没记过，由调用方用默认的。
 * 浏览器禁用了存储（隐私设置）或内容坏了（不是 JSON）也一样当没记过：记不住位置不能挡住聊天，也不删记下的偏好。
 */
function readStored<T>(storage: Pick<Storage, 'getItem'>, key: string, schema: z.ZodType<T>): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(storage.getItem(key) || 'null'));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
const storedAnchor = z.object({ version: z.literal(1), x: z.number(), y: z.number() });
export function readFloatingAnchor(storage: Pick<Storage, 'getItem'>, v: FloatingViewport) {
  const p = readStored(storage, floatingPositionKey, storedAnchor);
  return p ? fitFloatingAnchor(p, v) : defaultFloatingAnchor(v);
}
export function saveFloatingAnchor(storage: Pick<Storage, 'setItem'>, anchor: FloatingPoint) {
  try {
    storage.setItem(floatingPositionKey, JSON.stringify({ version: 1, ...anchor }));
  } catch {
    /* Still draggable when storage is unavailable. */
  }
}

export type FloatingDock = 'free' | 'dock-left' | 'dock-right';
export type FloatingMascot = FloatingPoint & { dock: FloatingDock };
export const floatingMascotKey = 'erp-assistant-mascot-v2';
export const mascotDockDistance = 24;
/** 小人放哪和浮动窗口放哪各记各的（窗口的是 floatingPositionKey） */
export function fitFloatingMascot(
  p: FloatingMascot,
  v: FloatingViewport,
  size: FloatingSize = mascotSize,
): FloatingMascot {
  const fitted = clampFloatingPosition({ x: p.x - size.width, y: p.y - size.height }, size, v);
  return {
    x:
      p.dock === 'dock-left'
        ? v.left + size.width / 2
        : p.dock === 'dock-right'
          ? v.left + v.width + size.width / 2
          : fitted.x + size.width,
    y: fitted.y + size.height,
    dock: p.dock,
  };
}
export function floatingMascotPosition(p: FloatingMascot, size: FloatingSize, v: FloatingViewport) {
  const fitted = fitFloatingMascot(p, v, size);
  return { x: fitted.x - size.width, y: fitted.y - size.height };
}
/** During dragging allow half the mascot outside either side, without losing the grab point. */
export function clampMascotDragPosition(p: FloatingPoint, size: FloatingSize, v: FloatingViewport) {
  return {
    x: clamp(p.x, v.left - size.width / 2, v.left + v.width - size.width / 2),
    y: clampFloatingPosition(p, size, v).y,
  };
}
export function settleFloatingMascot(
  p: FloatingPoint,
  size: FloatingSize,
  v: FloatingViewport,
): FloatingMascot {
  const left = p.x - v.left,
    right = v.left + v.width - p.x - size.width;
  const dock: FloatingDock =
    Math.min(left, right) <= mascotDockDistance
      ? left <= right
        ? 'dock-left'
        : 'dock-right'
      : 'free';
  return fitFloatingMascot({ x: p.x + size.width, y: p.y + size.height, dock }, v, size);
}
const storedMascot = z.object({
  version: z.literal(2),
  x: z.number(),
  y: z.number(),
  dock: z.enum(['free', 'dock-left', 'dock-right']),
});
export function readFloatingMascot(
  storage: Pick<Storage, 'getItem'>,
  v: FloatingViewport,
): FloatingMascot {
  const p = readStored(storage, floatingMascotKey, storedMascot);
  // 没记过、存储被禁用或内容坏了：放在默认的右下角
  return p ? fitFloatingMascot(p, v) : { ...defaultFloatingAnchor(v), dock: 'free' };
}
export function moveFloatingMascot(
  p: FloatingMascot,
  size: FloatingSize,
  v: FloatingViewport,
  dx: number,
  dy: number,
): FloatingMascot {
  if (!dx) return fitFloatingMascot({ ...p, y: p.y + dy }, v, size);
  const point = floatingMascotPosition(p, size, v);
  const next = { x: point.x + dx, y: point.y + dy };
  const awayFromEdge =
    (dx > 0 && point.x <= v.left + mascotDockDistance) ||
    (dx < 0 && point.x + size.width >= v.left + v.width - mascotDockDistance);
  return awayFromEdge
    ? fitFloatingMascot({ x: next.x + size.width, y: next.y + size.height, dock: 'free' }, v, size)
    : settleFloatingMascot(next, size, v);
}
export function saveFloatingMascot(storage: Pick<Storage, 'setItem'>, p: FloatingMascot) {
  try {
    storage.setItem(floatingMascotKey, JSON.stringify({ version: 2, ...p }));
  } catch {
    /* Dragging remains available without browser storage. */
  }
}

export const floatingSizeKey = 'erp-assistant-size-v1';
export function fitFloatingSize(s: FloatingSize, v: FloatingViewport): FloatingSize {
  return {
    width: clamp(s.width, Math.min(300, v.width - 16), Math.max(1, v.width - 16)),
    height: clamp(s.height, Math.min(260, v.height - 16), Math.max(1, v.height - 16)),
  };
}
const storedSize = z.object({ width: z.number().positive(), height: z.number().positive() });
export function readFloatingSize(
  storage: Pick<Storage, 'getItem'>,
  v: FloatingViewport,
): FloatingSize {
  const s = readStored(storage, floatingSizeKey, storedSize);
  return fitFloatingSize(s ?? { width: 440, height: 690 }, v);
}
export function resizeFloatingRect(
  rect: FloatingPoint & FloatingSize,
  direction: string,
  dx: number,
  dy: number,
  v: FloatingViewport,
) {
  const left = direction.includes('w')
    ? clamp(rect.x + dx, v.left + 8, rect.x + rect.width - Math.min(300, v.width - 16))
    : rect.x;
  const top = direction.includes('n')
    ? clamp(rect.y + dy, v.top + 8, rect.y + rect.height - Math.min(260, v.height - 16))
    : rect.y;
  const right = direction.includes('e')
    ? clamp(rect.x + rect.width + dx, rect.x + Math.min(300, v.width - 16), v.left + v.width - 8)
    : rect.x + rect.width;
  const bottom = direction.includes('s')
    ? clamp(rect.y + rect.height + dy, rect.y + Math.min(260, v.height - 16), v.top + v.height - 8)
    : rect.y + rect.height;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

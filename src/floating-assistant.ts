export type FloatingPoint = { x: number; y: number };
export type FloatingSize = { width: number; height: number };
export type FloatingViewport = FloatingSize & { left: number; top: number };
export const floatingPositionKey = 'erp-assistant-position-v1';
export const mascotSize: FloatingSize = { width: 88, height: 98 };
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
/** 顶部显示当前页面和正在看的记录，说明助手回答时参考的上下文。 */
const assistantPageNames: Record<string, string> = {
  dashboard: '今日',
  'ai-import': '收件箱',
  orders: '订单',
  customers: '客户',
  products: '产品',
  purchases: '采购',
  suppliers: '供应商',
  production: '生产',
  warehouse: '仓储',
  trash: '归档',
};
export function assistantPageLabel(hash: string, record?: string | null) {
  const name = assistantPageNames[hash.replace(/^#/, '').split('?')[0] || 'dashboard'];
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
export function readFloatingAnchor(storage: Pick<Storage, 'getItem'>, v: FloatingViewport) {
  try {
    const p = JSON.parse(storage.getItem(floatingPositionKey) || 'null');
    if (
      p?.version === 1 &&
      typeof p.x === 'number' &&
      typeof p.y === 'number' &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y)
    )
      return fitFloatingAnchor(p, v);
  } catch {
    /* Browser privacy settings/corrupt preferences must not prevent chat. */
  }
  return defaultFloatingAnchor(v);
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
/** Mascot placement is independent of the panel. Legacy v1 remains the panel anchor. */
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
export function readFloatingMascot(
  storage: Pick<Storage, 'getItem'>,
  v: FloatingViewport,
): FloatingMascot {
  try {
    const p = JSON.parse(storage.getItem(floatingMascotKey) || 'null');
    if (
      p?.version === 2 &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      ['free', 'dock-left', 'dock-right'].includes(p.dock)
    )
      return fitFloatingMascot(p, v);
  } catch {
    /* Fall back to the original position without deleting user preferences. */
  }
  return { ...readFloatingAnchor(storage, v), dock: 'free' };
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
export function readFloatingSize(
  storage: Pick<Storage, 'getItem'>,
  v: FloatingViewport,
): FloatingSize {
  try {
    const s = JSON.parse(storage.getItem(floatingSizeKey) || 'null');
    if (Number.isFinite(s?.width) && Number.isFinite(s?.height) && s.width > 0 && s.height > 0)
      return fitFloatingSize(s, v);
  } catch {}
  return fitFloatingSize({ width: 440, height: 690 }, v);
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

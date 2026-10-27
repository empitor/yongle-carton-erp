export type FloatingPoint = { x: number; y: number };
export type FloatingSize = { width: number; height: number };
export type FloatingViewport = FloatingSize & { left: number; top: number };
export const floatingPositionKey = 'erp-assistant-position-v1';
export const mascotSize: FloatingSize = { width: 88, height: 98 };
export const dragThreshold = 6;
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

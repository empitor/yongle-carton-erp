import type { PageSnapshot } from './assistant-page.js';
/** 仅压缩回传；客户端仍持有完整的当前控件映射和有效性签名。 */
export function pageSnapshotDelta(current: PageSnapshot, previous?: PageSnapshot): PageSnapshot {
  if (!previous || previous.route !== current.route || previous.mode !== current.mode)
    return current;
  const unchangedSections: string[] = [];
  const out = { ...current };
  for (const field of [
    'text',
    'selected',
    'dialogs',
    'tables',
    'tablesPage',
    'record',
    'title',
  ] as const) {
    if (JSON.stringify(current[field]) === JSON.stringify(previous[field])) {
      unchangedSections.push(field);
      if (field === 'text' || field === 'title') (out as any)[field] = '';
      else if (field === 'record') delete out.record;
      else (out as any)[field] = [];
    }
  }
  const before = new Map(previous.controls.map((c) => [c.id, c]));
  out.controls = current.controls.filter(
    (c) => JSON.stringify(c) !== JSON.stringify(before.get(c.id)),
  );
  out.delta = {
    baseSnapshotId: previous.snapshotId,
    unchangedSections,
    removedControlIds: previous.controls
      .filter((c) => !current.controls.some((n) => n.id === c.id))
      .map((c) => c.id),
  };
  return out;
}

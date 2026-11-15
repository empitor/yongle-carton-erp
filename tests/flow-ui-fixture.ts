// 单据页、生产页、仓库页渲染测试共用：虚构的生产任务、操作条的上下文、从渲染结果里取按钮。
import { createElement as h, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ProductionBatchDialog from '../src/flow/ProductionBatchDialog.js';
import type { FlowActionContext } from '../src/flow/FlowActions.js';

export const noop = () => {};
export const task = (id: number, status: string, completed = '0', extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'task' as const,
  number: 'SC-虚构-' + id,
  status,
  productId: id,
  productName: '虚构纸箱' + id,
  quantity: '100',
  completed,
  progress: Math.floor(Number(completed)),
  unit: '只',
  plannedDate: '2026-11-0' + id,
  version: 1,
  ...extra,
});
export const ctx = (over: Partial<FlowActionContext> = {}): FlowActionContext => ({
  local: false,
  superMode: false,
  canEdit: true,
  busy: false,
  begin: noop,
  setView: noop,
  review: noop,
  openCompletion: noop,
  exportDelivery: noop,
  setScheduling: noop,
  setReturning: noop,
  correct: noop,
  editInfo: noop,
  ask: noop,
  setContextId: noop,
  markDelivered: noop,
  ...over,
});
/** 操作条里的主按钮、可见按钮、“更多”里的项 */
export const actions = (html: string) => {
  const primary = /<button[^>]*class="primary"[^>]*>([^<]+)</.exec(html)?.[1];
  const more = html.split('more-menu-list')[1] || '';
  const visible = [...html.split('more-menu')[0].matchAll(/<button[^>]*>([^<]+)</g)].map((m) => m[1]);
  return { primary, visible, more };
};
/** 登记完工窗口：从 taskIds 这几张任务进来（空数组是页头进来） */
export const batchDialog = (tasks: ComponentProps<typeof ProductionBatchDialog>['tasks'], taskIds: number[]) =>
  renderToStaticMarkup(h(ProductionBatchDialog, { tasks, items: [], products: [], taskIds, close: noop, done: noop }));

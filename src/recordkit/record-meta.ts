import { useEffect } from 'react';
import type { Tone } from '../ui/index';
import { emit } from '../ui/index';

/**
 * 业务档案和单据详情共用的小工具：状态颜色、告诉助手正在看哪条记录。
 * 状态颜色全站只有这一个函数，按界面上的状态文字定：还没开始灰，等着办的蓝，进行中品牌色，
 * 完成绿，取消黄，撤销红。订单、采购单、到货、送货、完工、生产任务都用它。
 */
export function businessStatusTone(status: string | undefined | null): Tone {
  if (!status) return 'neutral';
  if (['待确认', '待订货', '已更正', '已归档'].includes(status)) return 'neutral';
  if (['已取消'].includes(status)) return 'warning';
  if (['已撤销', '已冲销', '已作废'].includes(status)) return 'danger';
  if (
    ['已发货', '已发完', '全部到货', '已到齐', '已完成', '已完工', '已入库', '已送达'].includes(status)
  )
    return 'success';
  if (['待发货', '待到货', '待送货', '待入库', '待生产'].includes(status)) return 'info';
  return 'accent';
}

/** 告诉助手当前打开的是哪条记录，和原来的详情一样只发上下文，不做别的。 */
export function useRecordContext(module: string, id: number, label: string) {
  useEffect(() => {
    emit('erp-ai-record-context', { module, id, label });
  }, [module, id, label]);
}

/** 详情里给助手认的一条：采购单用单号；供应商、库存品用名称（库存品带种类，分原材料、成品） */
type AgentRow = { id: number; number: string } | { id: number; name: string; kind?: string };

/** 采购单、供应商、库存品详情：告诉助手正在看哪条记录，并返回挂在正文上的记录标记（库存品按原材料、成品分） */
export function useAgentRecord(entity: string, row: AgentRow) {
  const module =
    entity === 'stock_items' ? ('kind' in row && row.kind === 'raw' ? 'raw_inventory' : 'finished_inventory') : entity;
  const label = 'number' in row ? row.number : row.name;
  useRecordContext(module, row.id, label);
  return { 'data-agent-module': module, 'data-agent-record': row.id, 'data-agent-label': label };
}

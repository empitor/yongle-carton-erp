/**
 * 助手确认卡片、核对区上给人看的固定说法，每条回复下面“这一轮服务器实际做了什么”那一行。
 * 只按服务器给的标记写（卡片现在的状态 state、requiresPassword、requiresSuperMode、destructive、localOnly，
 * 这一轮的 facts），不在前端猜；不露英文工具名。
 */
import type { CardStateName as CardState, JsonView } from '../../shared/assistant/index';
import type { TurnFacts } from './assistant-types';

/**
 * 卡片上要看的几项：编号、命令、标题、服务器标的现在的状态，和删除类方案的标记（requiresPassword 这些）。
 * 卡片除了编号、命令、标题，别的各命令不同、原样是 JSON（shared/assistant 的 PlanCard），所以这些标记按 JSON 收、按真假读。
 */
type PlanView = {
  id?: string;
  tool?: string;
  label?: string;
  state?: CardState;
  highRisk?: JsonView;
  destructive?: JsonView;
  requiresPassword?: JsonView;
  requiresSuperMode?: JsonView;
  localOnly?: JsonView;
  expiresAt?: JsonView;
  after?: JsonView;
};

/** 删除类方案里，是不是一键清空（按工具判断，只用来选“删除”还是“清空”这个词） */
const clears = (p: PlanView) => p.tool === 'management.reset';

/** 卡片现在算什么状态：服务器标的为准；还在等确认、但页面开着的时候过了有效期，也按过期 */
export function cardState(p: PlanView, now: number): CardState {
  if (p.state && p.state !== 'waiting') return p.state;
  return typeof p.expiresAt === 'number' && now > p.expiresAt ? 'expired' : 'waiting';
}

const settledNotes: Record<Exclude<CardState, 'waiting'>, string> = {
  executed: '已执行',
  failed: '执行没有成功 · 这张卡片不会再执行',
  unknown: '已经发出去，结果不明 · 先查一下再决定',
  cancelled: '没有执行（已作废）',
  expired: '已过期，没有执行',
};

/** 聊天里方案卡片标题下面那行小字 */
export function planCardNote(p: PlanView, now: number) {
  const state = cardState(p, now);
  if (state !== 'waiting') return settledNotes[state];
  if (p.destructive) {
    const head = clears(p) ? '清空后不能恢复' : '删除后不能恢复';
    if (p.requiresPassword)
      return (
        head + (p.requiresSuperMode ? ' · 超级管理员模式下输本人密码确认' : ' · 确认时要输本人密码')
      );
    if (p.localOnly) return head + ' · 只能在服务器本机确认';
    return head + ' · 核对后点确认才执行';
  }
  if (p.highRisk) return '影响较大 · 核对后点确认才执行';
  return '还没执行 · 核对后点确认';
}

/** 聊天里方案卡片上的按钮：只有还在等确认的才放 */
export function planCardButton(p: PlanView, now: number) {
  return cardState(p, now) === 'waiting' ? { label: '查看修改内容并确认' } : null;
}

/**
 * 核对区底部的确认按钮：删除、清空写这一步的结果，用红色实心；别的写“确认执行”。
 * passwordLabel 是密码框的标签，和页面删除窗口同一个说法（“输入本人密码确认删除”）。
 */
export function planConfirmButton(p: PlanView) {
  if (p.destructive)
    return clears(p)
      ? { label: '确认清空', className: 'danger-solid', passwordLabel: '输入本人密码确认清空' }
      : { label: '确认删除', className: 'danger-solid', passwordLabel: '输入本人密码确认删除' };
  return { label: '确认执行', className: 'primary', passwordLabel: '输入本人密码确认' };
}

/** 核对区里除了库存说明以外的固定提醒：删除说删除、清空说清空；删除记录的方案（有影响清单）说删前留快照 */
export function reviewNotes(p: PlanView) {
  const notes: string[] = [];
  if (p.destructive)
    notes.push(
      clears(p)
        ? '清空后不能恢复。助手不会自动执行，需要你在这里确认。'
        : '删除后不能恢复。助手不会自动执行，需要你在这里确认。',
    );
  const impact = typeof p.after === 'object' && p.after !== null && 'impact' in p.after ? p.after.impact : undefined;
  if (Array.isArray(impact)) notes.push('删除前系统会自动留一份恢复快照。');
  return notes;
}

const cardFacts: Record<CardState, string> = {
  waiting: '待确认',
  executed: '已确认执行',
  failed: '确认了但没执行成',
  unknown: '已发出去、结果不明',
  cancelled: '没有执行',
  expired: '过期没执行',
};

/**
 * “已执行：……”那一行里的一项：text 是原来那句；forget 有值就在后面放“忘掉”（值是记忆编号）；
 * forgotten 是这条记忆已经忘掉了（原来那句划掉，后面写“已忘掉”，让人知道撤的是哪一条）；note 是没忘成的原因。
 */
export type ExecutedItem = { text: string; forget?: number; forgotten?: true; note?: string };
/**
 * “已执行”那一行的各项。settled：记忆编号 → true（已经忘掉了）或没忘成的原因；
 * 记住、改过的长期记忆还在的，后面给“忘掉”。
 */
export function executedItems(executed: TurnFacts['executed'], settled: Readonly<Record<number, true | string>> = {}): ExecutedItem[] {
  return executed.map((e) => {
    if (e.memoryId === undefined) return { text: e.label };
    const state = settled[e.memoryId];
    if (state === true) return { text: e.label, forgotten: true };
    return { text: e.label, forget: e.memoryId, ...(state ? { note: state } : {}) };
  });
}

/** 回复下面的一行：text 是整行的字；“已执行”那一行另带各项（executed），页面按项画（长期记忆后面有“忘掉”） */
export type FactLine = { text: string; executed?: TurnFacts['executed'] };
/**
 * 回复下面固定的一行（几句）：这一轮服务器实际做了什么。是事实，不是助手说的话：
 * 只查了数据就写“只查询，没有改动”；出了确认卡片的按卡片现在的状态写；执行了的、没做成的照实列。
 * 什么工具都没用（纯聊天）不写。
 */
export function factLines(facts: TurnFacts | undefined, plans: PlanView[] | undefined, now: number): FactLine[] {
  if (!facts) return [];
  const lines: FactLine[] = [];
  const byState = new Map<CardState, string[]>();
  for (const card of facts.cards) {
    const plan = plans?.find((p) => p.id === card.id);
    const state = plan ? cardState(plan, now) : 'waiting';
    byState.set(state, [...(byState.get(state) ?? []), card.label]);
  }
  for (const [state, labels] of byState) lines.push({ text: cardFacts[state] + '：' + labels.join('；') });
  if (facts.executed.length) lines.push({ text: '已执行：' + facts.executed.map((e) => e.label).join('；'), executed: facts.executed });
  // 没做成的只列是哪一步；原因由助手用自己的话说（原始报错里有内部字段名，不直接给人看）
  if (facts.failed.length) lines.push({ text: '没做成：' + [...new Set(facts.failed.map((f) => f.label))].join('；') });
  if (!lines.length && facts.reads) lines.push({ text: '只查询，没有改动' });
  return lines;
}

import type { Dispatch, RefObject, SetStateAction } from 'react';
import { deliverBusinessFile } from '../documents/index';
import { emit, isNetworkError, notify, textField, type FileSaver } from '../ui/index';
import { errorMessage } from '../../shared/core/index';
import type { JsonView, PlanCard, ThreadView } from '../../shared/assistant/index';
import { changeInventoryPolicy, executePreview, rejectPreview, type AssistantState } from './assistant-api';
import type { CardDecision } from './assistant-types';
import { syncedReview, type ChatThread } from './thread-view';
import { readExportFile } from './chat-events';

/** 核对区里的一份方案（会话里消息带的卡片；改“库存怎么处理”后换成服务器重新生成的那份） */
export type ReviewPlan = PlanCard;

/** 改“库存怎么处理”时响应丢了，重新载入后卡片已按服务器上的那一版显示 */
const policyResponseLost = '没收到服务器的回应，卡片已按服务器上的最新一版重新显示，请看过再确认。';

/** 核对区的几个动作要用的东西（hook 每次渲染交进来） */
export type ReviewDeps = {
  userId: string | undefined;
  userRef: RefObject<string | undefined>;
  threadRef: RefObject<ChatThread | null>;
  thread: ChatThread | null;
  loadThread: (id: string) => Promise<ThreadView | null>;
  /** 重读会话列表（助手删了聊天记录以后） */
  loadState: () => Promise<AssistantState>;
  setError: (message: string) => void;
  /** 人点了确认（已执行）或不执行（已作废）：把结果交给助手接着办 */
  onDecided: (card: CardDecision) => void;
  setReview: Dispatch<SetStateAction<ReviewPlan | null>>;
  reviewRef: RefObject<HTMLElement | null>;
  /** 导出类方案执行后保存文件（useSaveFile） */
  saveFile: FileSaver;
};

/** 服务器说 409：卡片上看到的已经不是现在这一版 */
const isConflict = (e: unknown) => e instanceof Error && 'status' in e && e.status === 409;

/** 核对区回到顶部（从汇总开始看） */
export function scrollReviewTop(reviewRef: RefObject<HTMLElement | null>) {
  reviewRef.current?.querySelector('.ga-review-body')?.scrollTo?.({ top: 0 });
}

/**
 * 核对区停在旧版时重新同步：重新载入聊天，核对区换成库里存的这份方案（改选失败、改选的响应丢了、
 * 执行时服务器说方案已重新核算）。方案已经执行或不在了就关掉核对区，聊天里看结果。
 */
async function syncReview(d: ReviewDeps, id: string, owner: string | undefined) {
  const threadId = d.threadRef.current?.id;
  // 重新载入失败：出错说明已经由调用方报了，卡片保持原样
  const current = threadId ? await d.loadThread(threadId).catch(() => null) : null;
  if (!current || d.userRef.current !== owner) return false;
  const next = syncedReview(current, id);
  d.setReview((shown) => (shown?.id !== id ? shown : next));
  // 换成最新一版后从头看起：“库存怎么处理”和汇总在核对区最上面
  requestAnimationFrame(() => scrollReviewTop(d.reviewRef));
  return true;
}

/** 删除卡片上改“库存怎么处理”：服务器重新生成这份方案，卡片换成新方案（清单、汇总、库存说明都跟着变） */
export async function changeReviewPolicy(d: ReviewDeps, review: ReviewPlan, inventoryPolicy: string) {
  const owner = d.userId,
    id = review.id;
  try {
    const next = await changeInventoryPolicy(id, inventoryPolicy);
    if (d.userRef.current !== owner) return;
    d.setReview((current) => (current?.id === id ? next : current));
    if (d.thread?.id) await d.loadThread(d.thread.id);
  } catch (e) {
    d.setError(errorMessage(e));
    // 失败或响应丢了：服务器上可能已经换了选项，卡片不能停在旧版，按库里存的重新显示
    const synced = await syncReview(d, id, owner);
    // 响应丢了但重新载入成功：说清楚卡片已换成服务器上的那一版，不只说连不上
    if (synced && isNetworkError(e)) d.setError(policyResponseLost);
  }
}

/** 执行的结果（各命令自己的样子，页面只按名字看 file、deleted、currentCleared） */
type ExecutedResult = Awaited<ReturnType<typeof executePreview>>;
/** 执行成功以后和浏览器打交道的几件事：下载导出的文件、下载失败怎么说、告诉别的页面数据变了 */
export type ExecutedEffects = {
  /** 交回导出记录（文件存好后单据状态才改），这里只等它做完 */
  download: (file: JsonView) => Promise<unknown>;
  downloadFailed: (message: string) => void;
  announce: () => void;
};
const pageEffects = (save: FileSaver): ExecutedEffects => ({
  // 导出类的卡片：文件保存好（浏览器下载，安卓 App 里存进手机“下载”）之后单据状态才改（和人工导出同一条路）
  download: (file) => deliverBusinessFile(readExportFile(file), save),
  // 助手接着办时会清掉输入框上方的出错说明，下载失败放在页面底部的提示里，看得到
  downloadFailed: (message) => notify(message, 'error'),
  announce: () => {
    emit('erp-business-changed');
    // 识别工作区的归档、恢复、复制、删除：AI 导入页的列表跟着变
    emit('erp-ai-workspace-list-changed');
  },
});
type AfterDeps = Pick<ReviewDeps, 'thread' | 'loadThread' | 'loadState' | 'onDecided'>;

/**
 * 确认执行成功以后：下载导出的文件、刷新聊天和别的页面、交回助手。
 * 下载失败只说明原因：执行已经成功了，照样刷新、照样交回助手接着办。
 */
export async function afterExecuted(d: AfterDeps, id: string, result: ExecutedResult, effects: ExecutedEffects) {
  if (result.file)
    try {
      await effects.download(result.file);
    } catch (e) {
      effects.downloadFailed(errorMessage(e));
    }
  if (d.thread?.id) await d.loadThread(d.thread.id);
  effects.announce();
  // 删了聊天记录：左边的会话列表跟着变；刷新不成不影响已经执行的结果，下次打开助手会重读
  if (result.deleted !== undefined) void d.loadState().catch(() => undefined);
  if (!result.currentCleared) d.onDecided({ id, decision: 'confirmed' });
}

/** 确认执行；password 是删除类方案要人自己输的密码 */
export async function executeReview(d: ReviewDeps, review: ReviewPlan, password: string, clearPassword: () => void) {
  const owner = d.userId,
    id = review.id;
  try {
    // 带上卡片上看到的范围摘要：卡片上能改库存处理方式，服务器核对人确认的就是现在要执行的这一版
    const digest = textField(review.args, 'deletionDigest');
    const result = await executePreview(id, {
      ...(digest ? { deletionDigest: digest } : {}),
      ...(review.requiresPassword ? { password } : {}),
    });
    clearPassword();
    if (d.userRef.current !== owner) return;
    d.setReview(null);
    await afterExecuted(d, id, result, pageEffects(d.saveFile));
  } catch (e) {
    d.setError(errorMessage(e));
    // 出卡片以后数据变了，服务器把这张卡片作废了：和点“不执行”之后一样收起核对区、交回助手，让它按最新数据重新出一张
    if (textField(e, 'code') === 'card-stale') {
      if (d.userRef.current !== owner) return;
      d.setReview(null);
      if (d.thread?.id) await d.loadThread(d.thread.id);
      d.onDecided({ id, decision: 'rejected' });
      return;
    }
    // 409：卡片上看到的已经不是现在这一版（另一个页面改了库存处理方式等），换成最新的让人看过再确认
    if (isConflict(e)) await syncReview(d, id, owner);
  }
}

/** 不执行：这份方案作废，告诉助手 */
export async function rejectReview(d: ReviewDeps, review: ReviewPlan) {
  const owner = d.userId,
    id = review.id;
  try {
    await rejectPreview(id);
    if (d.userRef.current !== owner) return;
    d.setReview(null);
    if (d.thread?.id) await d.loadThread(d.thread.id);
    d.onDecided({ id, decision: 'rejected' });
  } catch (e) {
    d.setError(errorMessage(e));
    if (isConflict(e)) await syncReview(d, id, owner);
  }
}

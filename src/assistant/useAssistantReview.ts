import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  changeReviewPolicy,
  executeReview,
  rejectReview,
  scrollReviewTop,
  type ReviewDeps,
  type ReviewPlan,
} from './review-actions';

type ReviewOptions = Omit<ReviewDeps, 'setReview' | 'reviewRef'> & {
  /** 聊天记录区：打开核对区时停在最后一条 */
  history: RefObject<HTMLDivElement | null>;
};

/** 核对区打开时滚进视野（手机上整个面板会滚动），确认按钮完整可见；不抢焦点 */
function useReviewScroll(reviewId: string | undefined, history: RefObject<HTMLDivElement | null>) {
  const reviewRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!reviewId) return;
    // 打开核对区：核对区自己回到顶部（从汇总开始看），整个核对区滚进视野；聊天记录停在最后一条，给核对区让出位置
    scrollReviewTop(reviewRef);
    reviewRef.current?.scrollIntoView?.({ block: 'nearest' });
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
    // history 是聊天记录区的引用，一直是同一个对象，列进来不会多滚
  }, [reviewId, history]);
  return reviewRef;
}

/**
 * 核对区：正在核对哪份方案、删除方案改“库存怎么处理”、输密码、确认执行、不执行；确认或拒绝后把结果交给助手接着办；卡片停在旧版时按服务器上的重新显示；
 * 打开时把核对区滚进视野。
 */
export function useAssistantReview({ history, ...options }: ReviewOptions) {
  const [review, setReview] = useState<ReviewPlan | null>(null),
    [switchingPolicy, setSwitchingPolicy] = useState(false),
    [executing, setExecuting] = useState(false),
    // 删除类方案要人自己输入密码，换方案时清空。
    [reviewPassword, setReviewPassword] = useState('');
  useEffect(() => {
    setReviewPassword('');
  }, [review?.id]);
  const reviewRef = useReviewScroll(review?.id, history);
  const deps: ReviewDeps = { ...options, setReview, reviewRef };
  /** 动作进行中按钮置灰：先清掉上一次的错误，做完（成功失败都一样）放开 */
  async function running(set: (busy: boolean) => void, work: (plan: ReviewPlan) => Promise<void>) {
    if (!review) return;
    set(true);
    options.setError('');
    try {
      await work(review);
    } finally {
      set(false);
    }
  }
  return {
    /** 正在核对的方案；没在核对是 null */
    plan: review,
    /** 点方案卡片打开核对区，顺手清掉上一次的错误 */
    show: (plan: ReviewPlan) => {
      setReview(plan);
      options.setError('');
    },
    close: () => setReview(null),
    switchingPolicy,
    executing,
    reviewPassword,
    setReviewPassword,
    /** 删除卡片上改“库存怎么处理” */
    changePolicy: (inventoryPolicy: string) =>
      running(setSwitchingPolicy, (plan) => changeReviewPolicy(deps, plan, inventoryPolicy)),
    execute: () =>
      running(setExecuting, (plan) => executeReview(deps, plan, reviewPassword, () => setReviewPassword(''))),
    /** 不执行：这份方案作废，告诉助手 */
    reject: () => running(setExecuting, (plan) => rejectReview(deps, plan)),
    reviewRef,
    /** 换账号：不再执行、不再核对 */
    reset: () => {
      setExecuting(false);
      setReview(null);
    },
  };
}

import { useEffect, useRef, type RefObject } from 'react';
import { X } from 'lucide-react';
import { inventoryOptions } from '../../shared/business/index';
import type { PlanCard } from '../../shared/assistant/index';
import { DeletionImpact } from '../recordkit/index';
import { planConfirmButton, reviewNotes } from './plan-card';
import { reviewView, type ReviewView } from './review-view';

/** 服务器写好的卡片内容（动的是哪条、会发生什么），原样逐行列出 */
function SummaryLines({ lines }: { lines: { label: string; value: string }[] }) {
  return (
    <div className="ga-changes">
      {lines.map((line, i) => (
        <div key={i}>
          <strong>{line.label}</strong>
          <span>{line.value}</span>
        </div>
      ))}
    </div>
  );
}

/** 删除涉及出入库流水时和页面删除窗口一样让人选库存怎么处理；改了由服务器重新生成这份方案（新摘要） */
function ReviewPolicy({
  view,
  disabled,
  onPolicy,
}: {
  view: ReviewView;
  disabled: boolean;
  onPolicy: (inventoryPolicy: string) => void;
}) {
  // 选项文字和页面删除窗口同一份：删单据说“这张单子”，删档案说“连带删掉的单据”“只删记录”
  const options = inventoryOptions(view.policyModule);
  return (
    <label className="ga-review-policy">
      库存怎么处理
      <select
        aria-label="库存怎么处理"
        value={view.policy}
        disabled={disabled}
        onChange={(e) => onPolicy(e.target.value)}
      >
        <option value="recalculate">{options.recalculate}</option>
        <option value="preserve">{options.preserve}</option>
      </select>
    </label>
  );
}

type Props = {
  review: PlanCard;
  reviewRef: RefObject<HTMLElement | null>;
  executing: boolean;
  switchingPolicy: boolean;
  password: string;
  onPassword: (password: string) => void;
  onPolicy: (inventoryPolicy: string) => void;
  onExecute: () => void;
  /** 不执行：这份方案作废，助手会知道 */
  onReject: () => void;
  onClose: () => void;
};

/** 核对区中间自己滚动的部分：库存怎么处理、改了什么或会删掉什么、提醒、密码 */
function ReviewBody({ review, view, ...p }: Props & { view: ReviewView }) {
  const confirm = planConfirmButton(review);
  return (
    <div className="ga-review-body">
      {view.choosePolicy && (
        <ReviewPolicy view={view} disabled={p.executing || p.switchingPolicy} onPolicy={p.onPolicy} />
      )}
      {/* 删除方案：列出会一起删掉、解除引用的记录，不按字段对比（删除后每个字段都是空的） */}
      {view.impactPlan ? (
        <DeletionImpact plan={view.impactPlan} />
      ) : (
        // 卡片内容由服务器在出方案时写好（动的是哪条、会发生什么），页面不拿改前改后去猜
        <SummaryLines lines={view.summary} />
      )}
      {/* 库存说明、不可恢复、快照：和页面删除窗口一样分块说，删除说删除、清空说清空 */}
      <div className="ga-review-notes">
        {[...view.warnings, ...reviewNotes(review)].map((w, i) => (
          <p key={i}>{w}</p>
        ))}
      </div>
      {view.requiresPassword && (
        <label>
          {confirm.passwordLabel}
          <input
            type="password"
            autoComplete="current-password"
            data-agent-private
            value={p.password}
            disabled={p.executing}
            onChange={(e) => p.onPassword(e.target.value)}
          />
        </label>
      )}
    </div>
  );
}

/** 删除写“确认删除”（会删到库存流水或单据时红色实心），清空写“确认清空”，别的写“确认执行”（planConfirmButton）。按钮区固定在核对区底部 */
function ReviewActions({ review, view, ...p }: Props & { view: ReviewView }) {
  const confirm = planConfirmButton(review),
    headline = view.headline;
  return (
    <div className="ga-review-actions">
      <button disabled={p.executing || p.switchingPolicy} onClick={p.onReject}>
        不执行
      </button>
      <button
        className={headline ? (headline.alarming ? 'danger-solid' : 'danger') : confirm.className}
        disabled={p.executing || p.switchingPolicy || (view.requiresPassword && !p.password)}
        onClick={p.onExecute}
      >
        {p.executing ? '正在提交…' : p.switchingPolicy ? '正在重新核算…' : confirm.label}
      </button>
    </div>
  );
}

/**
 * 核对区（只显示）：方案标题、删除方案的“库存怎么处理”、改了什么或会删掉什么、提醒、密码、“不执行”和确认按钮。
 * 标题和确认按钮固定，中间内容自己滚动；不透明的底、清楚的上边界，不盖住也不透出聊天文字。
 */
export default function AssistantReview(props: Props) {
  const { review, reviewRef, executing, onClose } = props;
  // 删除方案：标题已经写明连带删掉几张什么单据，按钮只写“确认删除”（标题再抄一遍会在窄窗口里超出面板）；
  // 会删到库存流水或单据时红色实心、焦点先放在关闭上，和页面删除窗口同一个判断（deletionHeadline）
  const view = reviewView(review),
    alarming = view.headline?.alarming,
    closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (alarming) closeButton.current?.focus();
  }, [review.id, alarming]);
  return (
    <section className="ga-review" ref={reviewRef} aria-label={review.label + ' · 最后核对'}>
      <div className="ga-review-head">
        <strong>{review.label} · 最后核对</strong>
        <button ref={closeButton} disabled={executing} aria-label="关闭核对方案" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <ReviewBody {...props} view={view} />
      <ReviewActions {...props} view={view} />
    </section>
  );
}

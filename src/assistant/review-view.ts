import { z } from 'zod';
import { deletionHeadline, deletionSelection, impactRowSchema } from '../../shared/business/index';
import type { JsonView, PlanCard } from '../../shared/assistant/index';
import { isRecord } from '../../shared/core/index';
import { textField } from '../ui/index';

/*
 * 核对区按卡片里哪几项显示（只读出来，不改卡片）：卡片除了编号、命令、标题，别的原样是 JSON（PlanCard），
 * 删除方案的 after 是删除预览（shared/business 的 DeletionApi 里的 DeletionPreview），这里按它认。
 */

const impactRows = z.array(impactRowSchema);
const warningLines = z.array(z.string());

const parsedOrUndefined = <T>(schema: z.ZodType<T>, value: JsonView | undefined) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

/** 删除方案要看的：选了哪些、影响清单（不是删除方案就都没有） */
function deletionParts(review: PlanCard) {
  const after = isRecord(review.after) ? review.after : undefined;
  return {
    // 选了哪些：和服务端删除引擎同一份结构（模块、每条的编号和版本、库存怎么处理）
    selection: parsedOrUndefined(deletionSelection, after?.selection),
    impact: parsedOrUndefined(impactRows, after?.impact),
    inventoryChoice: Number(after?.inventoryChoice),
  };
}

/** 核对区要显示的内容 */
export function reviewView(review: PlanCard) {
  const { selection, impact, inventoryChoice } = deletionParts(review);
  const isDelete = review.tool === 'records.delete';
  // 删除方案：和页面删除窗口同一个判断（deletionHeadline）决定按钮颜色和焦点
  const headline =
    isDelete && selection && impact ? deletionHeadline(selection.module, selection.items, impact) : null;
  return {
    headline,
    /** 删除涉及出入库流水时让人选库存怎么处理 */
    choosePolicy: isDelete && inventoryChoice > 0,
    policy: selection?.inventoryPolicy ?? 'recalculate',
    policyModule: selection?.module || textField(review.args, 'module') || '',
    /** 删除方案的影响清单；不是删除方案时按服务器写好的逐行内容显示 */
    impactPlan: impact ? { impact, selection } : null,
    summary: review.summary ?? [],
    warnings: parsedOrUndefined(warningLines, review.warnings) ?? [],
    requiresPassword: Boolean(review.requiresPassword),
  };
}
export type ReviewView = ReturnType<typeof reviewView>;

import { isDeepStrictEqual } from 'node:util';
import { ImportError } from '../import/errors.js';
import type { Actor } from '../auth.js';
import type { AssistantTools } from './tools.js';
import type { AssistantTaskLedger } from './tasks.js';
/** 每步只核验执行前绑定的目标，兼容旧参数但绝不使用其覆盖步骤目标。 */
export function verifyPageOutcome(
  args: { stepIds: string[]; module?: string; id?: number; expected?: Record<string, unknown> },
  actor: Actor,
  threadId: string,
  tools: AssistantTools,
  ledger: AssistantTaskLedger,
) {
  const task = ledger.get(threadId, actor);
  const steps = [...new Set(args.stepIds)].map((id) => task?.steps.find((s) => s.id === id));
  if (!steps.length || steps.some((s) => !s || s.tool !== 'page.act'))
    throw new ImportError('只能核验当前账号当前任务中的真实页面步骤。', 403);
  const results = steps.map((step) => {
    const s = step!,
      target = s.pageOutcome;
    try {
      if (!Number.isInteger(target?.beforeVersion) || (target?.beforeVersion || 0) < 1)
        throw new ImportError('缺少真实的执行前业务版本，不能核验完成。', 409);
      if (!s.attemptedAt || !target || !['waiting', 'uncertain', 'completed'].includes(s.state))
        throw new ImportError('该步骤未执行、未预先绑定目标或操作已明确失败；不能标记完成。', 409);
      if (args.module !== undefined || args.id !== undefined || args.expected !== undefined) {
        if (
          args.module !== target.module ||
          args.id !== target.id ||
          !isDeepStrictEqual(args.expected, target.expected)
        )
          throw new ImportError('传入核验目标不等于该步骤预先绑定的完整目标。', 409);
      }
      if (
        target.beforeValues &&
        Object.keys(target.expected).every((k) =>
          isDeepStrictEqual(target.beforeValues?.[k], target.expected[k]),
        )
      )
        throw new ImportError('目标在操作前已满足，不能据此认定该步骤实际执行完成。', 409);
      const current = tools.read(
        'records.get',
        {
          module: target.module,
          id: target.id,
          ...(target.expected.archived === true ? { lifecycle: 'archived' } : {}),
        },
        actor,
      );
      if (
        !Number.isInteger(current.record?.version) ||
        current.record.version <= target.beforeVersion
      )
        throw new ImportError('未发现该步操作后的业务版本变化，结果仍待核实。', 409);
      const mismatched = Object.keys(target.expected).filter(
        (k) =>
          !Object.hasOwn(current.record, k) ||
          !isDeepStrictEqual(current.record[k], target.expected[k]),
      );
      if (mismatched.length)
        throw new ImportError('该步目标字段尚不符合：' + mismatched.join('、'), 409);
      ledger.update(threadId, actor, s.id, {
        state: 'completed',
        error: undefined,
        verification: {
          at: new Date().toISOString(),
          currentStateVerified: true,
          receiptVerified: false,
          module: target.module,
          id: target.id,
          expected: target.expected,
          version: current.record.version,
        },
        result: {
          status: 'verified-current-state',
          record: current.record,
          message: '仅该步骤预先绑定的目标已从原业务服务核验；未重放页面提交。',
        },
      });
      return {
        stepId: s.id,
        success: true,
        module: target.module,
        id: target.id,
        fields: Object.keys(target.expected),
        version: current.record.version,
      };
    } catch (e) {
      return { stepId: s.id, success: false, message: e instanceof Error ? e.message : '核验失败' };
    }
  });
  const completed = results.filter((r) => r.success).length;
  return {
    status: 'verified-current-state',
    businessVerified: completed === results.length,
    completed,
    failed: results.length - completed,
    results,
    message: `逐步核验通过${completed}项，未通过${results.length - completed}项；未通过步骤保持原状态。`,
  };
}

import type { AgentExecutionState, AgentQuestion } from '../../shared/assistant-task.js';
import { toolCatalog } from './tools.js';
export const MAX_MESSAGE_CHARS = 16000;
export const MAX_TOOL_CALLS = Number(process.env.ERP_AGENT_CALLS_PER_REPLY ?? 0);
if (!Number.isSafeInteger(MAX_TOOL_CALLS) || MAX_TOOL_CALLS < 0)
  throw new Error('ERP_AGENT_CALLS_PER_REPLY必须为非负安全整数；0表示不限制');
export type AssistantToolCall = { name: string; args: Record<string, unknown>; stepId?: string };
export type RejectedToolCall = { name: string; reason: string };
export type NormalizedAssistantReply = {
  message: string;
  toolCalls: AssistantToolCall[];
  rejected: RejectedToolCall[];
  mode: 'envelope' | 'text' | 'empty';
  issues: string[];
  keys: string[];
  taskUpdate?: unknown;
  status?: AgentExecutionState;
  questions?: AgentQuestion[];
  taskControl?: { mode: 'new' | 'continue'; goal?: string };
};
const registered = new Set(toolCatalog.map((t) => t.name));
// 常见兼容模型会使用别名或包裹字段；按顺序取第一个非空文本，不猜测其他业务字段。
const textKeys = ['message', 'answer', 'reply', 'text', 'content', '回复', '回答', '消息', '说明'];
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const clip = (v: string, max = MAX_MESSAGE_CHARS) => (v.length > max ? v.slice(0, max) : v);
const keyLabel = (v: string) => v.slice(0, 40).replace(/[^\w.\-\u4e00-\u9fff]/g, '');
function textOf(value: unknown): { text: string | null; converted: boolean } {
  if (typeof value === 'string') return { text: value, converted: false };
  if (typeof value === 'number' || typeof value === 'boolean')
    return { text: String(value), converted: true };
  if (Array.isArray(value) && value.every((v) => typeof v === 'string'))
    return { text: value.join('\n'), converted: true };
  if (isPlainObject(value) || Array.isArray(value)) {
    try {
      return { text: JSON.stringify(value), converted: true };
    } catch {
      return { text: null, converted: true };
    }
  }
  return { text: null, converted: false };
}
function parseObjectText(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
/**
 * 把模型原始返回归一化成可展示文本 + 合法工具调用。
 * 纯文字、缺少 toolCalls、额外字段都按正常文字回复处理；
 * 未注册工具、非对象参数、超过每轮上限的调用只进入 rejected，绝不进入执行路径。
 */
export function normalizeAssistantReply(
  raw: unknown,
  registeredTools: ReadonlySet<string> = registered,
  maxCalls = MAX_TOOL_CALLS,
): NormalizedAssistantReply {
  const empty = (issues: string[], keys: string[] = []): NormalizedAssistantReply => ({
    message: '',
    toolCalls: [],
    rejected: [],
    mode: 'empty',
    issues,
    keys,
  });
  if (typeof raw === 'string') {
    const value = raw.trim();
    if (!value) return empty(['模型返回了空文本']);
    const parsed = parseObjectText(value);
    // 双重编码/代码围栏仅兼容展示文字；字符串里的工具示例绝不进入调用链路。
    if (
      isPlainObject(parsed) &&
      (!parsed.toolCalls || (Array.isArray(parsed.toolCalls) && parsed.toolCalls.length === 0))
    )
      return { ...normalizeAssistantReply(parsed), toolCalls: [], rejected: [] };
    return {
      message: clip(value),
      toolCalls: [],
      rejected: [],
      mode: 'text',
      issues: [],
      keys: [],
    };
  }
  if (Array.isArray(raw)) {
    const text = raw
      .filter((v): v is string => typeof v === 'string')
      .join('\n')
      .trim();
    if (!text) return empty(['模型返回了空数组']);
    return {
      message: clip(text),
      toolCalls: [],
      rejected: [],
      mode: 'text',
      issues: ['回复不是对象，已按文字处理'],
      keys: [],
    };
  }
  if (!isPlainObject(raw)) return empty(['回复不是 JSON 对象']);

  const keys = Object.keys(raw).slice(0, 30).map(keyLabel);
  const issues: string[] = [];
  let message = '',
    usedKey: string | null = null;
  for (const key of textKeys) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = textOf(raw[key]);
    if (value.text && value.text.trim()) {
      message = value.text.trim();
      usedKey = key;
      if (value.converted) issues.push('文字字段不是字符串，已安全转换');
      break;
    }
  }
  if (!usedKey) issues.push('回复缺少文字说明');
  if (message.length > MAX_MESSAGE_CHARS) {
    message = clip(message);
    issues.push('文字说明超过长度上限，已截断');
  }

  const toolCalls: AssistantToolCall[] = [];
  const rejected: RejectedToolCall[] = [];
  if ((Array.isArray(raw.tool_calls) && raw.tool_calls.length) || raw.function_call) {
    return {
      message,
      toolCalls: [],
      rejected: [{ name: '原生工具字段', reason: '当前仅启用自定义JSON信封，原生工具字段未执行' }],
      mode: message ? 'text' : 'empty',
      issues: ['原生工具协议与JSON信封混用'],
      keys,
    };
  }
  const rawCalls = raw.toolCalls;
  if (rawCalls !== undefined && rawCalls !== null && !Array.isArray(rawCalls)) {
    issues.push('toolCalls 不是数组，已忽略');
    rejected.push({ name: 'toolCalls', reason: '回复中的工具列表格式不合法，已拒绝执行' });
  }
  if (Array.isArray(rawCalls)) {
    if (maxCalls > 0 && rawCalls.length > maxCalls)
      issues.push('工具调用超过每轮上限，超出部分已拒绝');
    rawCalls.forEach((call, index) => {
      if (maxCalls > 0 && index >= maxCalls) {
        rejected.push({
          name: '超出上限',
          reason: `本次回复服务端配置最多${maxCalls}个调用，超出部分未执行`,
        });
        return;
      }
      if (!isPlainObject(call)) {
        rejected.push({ name: '格式错误', reason: '工具调用不是对象，已拒绝执行' });
        return;
      }
      const name = typeof call.name === 'string' ? call.name.trim() : '';
      if (!name) {
        rejected.push({ name: '未命名', reason: '工具调用缺少名称，已拒绝执行' });
        return;
      }
      if (!registeredTools.has(name)) {
        rejected.push({ name: clip(name, 80), reason: '未注册的工具，已拒绝执行' });
        return;
      }
      const args = call.args === undefined || call.args === null ? {} : call.args;
      if (!isPlainObject(args)) {
        rejected.push({ name: clip(name, 80), reason: '工具参数不是对象，已拒绝执行' });
        return;
      }
      const stepId =
        typeof call.stepId === 'string' && /^[0-9a-f-]{36}$/.test(call.stepId)
          ? call.stepId
          : undefined;
      toolCalls.push({ name, args, ...(stepId ? { stepId } : {}) });
    });
  }
  const mode: NormalizedAssistantReply['mode'] = toolCalls.length
    ? 'envelope'
    : message
      ? 'text'
      : 'empty';
  return {
    message,
    toolCalls,
    rejected,
    mode,
    issues,
    keys,
    ...(['working', 'needs_input', 'completed', 'blocked'].includes(String(raw.status))
      ? { status: raw.status as AgentExecutionState }
      : {}),
    ...(isPlainObject(raw.taskUpdate) ? { taskUpdate: raw.taskUpdate } : {}),
    ...(isPlainObject(raw.taskControl) && ['new', 'continue'].includes(String(raw.taskControl.mode))
      ? {
          taskControl: {
            mode: raw.taskControl.mode as 'new' | 'continue',
            goal:
              typeof raw.taskControl.goal === 'string'
                ? raw.taskControl.goal.slice(0, 1000)
                : undefined,
          },
        }
      : {}),
    ...(Array.isArray(raw.questions)
      ? {
          questions: raw.questions
            .slice(0, 20)
            .filter(
              (q) =>
                isPlainObject(q) &&
                typeof q.key === 'string' &&
                typeof q.question === 'string' &&
                q.question.length <= 500,
            ) as any,
        }
      : {}),
  };
}

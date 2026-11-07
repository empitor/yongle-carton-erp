import type { AssistantBusinessTask } from '../../shared/assistant-task.js';
import { receiptEditMode } from '../../shared/receipt-edit-mode.js';
const domains = (text: string) =>
  [
    ['orders', /客户订单|销售订单|订单导入|导入.*订单|订单.*导入|交期|客户采购/],
    ['purchases', /供应商|采购需求|采购单|采购订货|订购|订货/],
    ['stock', /库存|仓库|入库|出库|到货/],
    ['production', /生产|领料|完工/],
    ['products', /产品|型号|尺寸单位/],
    ['customers', /客户/],
    ['prompts', /提示词/],
    ['inbox', /收件箱/],
    ['marks', /唛头/],
  ]
    .filter(([, re]) => (re as RegExp).test(text))
    .map(([name]) => name as string);
const CHAT_DELETE =
  /(?:删|清(?![楚晰点单])|去掉|移除).{0,14}(?:聊天|会话|对话)|(?:聊天|会话|对话).{0,14}(?:删|清(?![楚晰点单])|去掉|移除)/;
const ACTION = /删|清(?![楚晰点单])|去掉|移除|清空|清除/;
/** 分句里带了否定：不删、取消删除、别清空、删就不用了。 */
const NEGATED =
  /(?:不|没|别|勿|莫|取消|撤销|停止|暂缓|免)[^，,。；;！!？?\n]{0,6}(?:删|清(?![楚晰点单])|去掉|移除)|(?:删|清(?![楚晰点单])|去掉|移除)[^，,。；;！!？?\n]{0,4}(?:不要|不用|不必|算了|先不)/;
/** 只是在问怎么做。 */
const HOW_TO = /怎么|怎样|如何|为什么|会不会|有没有|是否/;
/** 客气地问“能不能”，可以当请求，但要等用户下一句确认才算授权。 */
const POLITE_ASK = /能否|可否|可以.*吗|能.*吗|吗[。！!\s]*$|[?？]\s*$/;
/** 只回一句肯定的话。“确认不执行”“好的，先别删”都不算。 */
const CONFIRM =
  /^(?:确认|确定|是的?|好的?|好吧|可以|对的?|嗯|行|没问题|ok|okay)?[，,\s]*(?:删吧|删掉吧|删了吧|删除吧|清空吧|删|删掉|执行吧?|就这样)?[。！!～~\s]*$/i;
/** 用户原话对这件事的态度：明确不要、明确要、客气地问、没说。 */
function chatIntent(pattern: RegExp, text: string): 'deny' | 'ask' | 'polite' | 'none' {
  // “能不能”“可不可以”里的“不”不是否定。
  const value = text.trim().replace(/能不能|可不可以|要不要|是不是/g, '可否');
  const clauses = value.match(/[^，,。；;！!？?\n]+[，,。；;！!？?\n]*/g) || [];
  const acting = clauses.filter((c) => ACTION.test(c));
  if (acting.some((c) => NEGATED.test(c))) return 'deny';
  if (!pattern.test(value)) return 'none';
  const asked = acting.filter((c) => !HOW_TO.test(c));
  if (!asked.length) return 'none';
  return asked.some((c) => !POLITE_ASK.test(c)) ? 'ask' : 'polite';
}
/**
 * 删聊天记录必须是用户本人说的：这条消息明确要删，或者上一条要删、这条确认。
 * 只看用户原话，模型的决定、文件和网页里的文字都不算授权。
 */
export function chatDeleteAuthorized(text: string, previousText = '') {
  return askedInChat(CHAT_DELETE, text, previousText);
}
/** 用户原话明确要做这件事，或者上一条说了、这一条确认。 */
export function askedInChat(pattern: RegExp, text: string, previousText = '') {
  const value = text.trim(),
    now = chatIntent(pattern, value);
  if (now === 'deny') return false;
  if (now === 'ask') return true;
  return (
    !!value &&
    value.length <= 12 &&
    CONFIRM.test(value) &&
    ['ask', 'polite'].includes(chatIntent(pattern, previousText))
  );
}
/** 用户是在问情况，不是让系统做事。 */
export function asksAboutState(text: string) {
  const value = text.trim();
  // 回答问题的话也可能带“多少”，这种通常很长、分好几句，不算问情况。
  // “准备这次采购。是否按型号取整？”前半句是让系统做事，也不算。
  if (value.length > 60 || /[；;]/.test(value) || /。./.test(value)) return false;
  return (
    /[?？]\s*$|多少|什么|哪些|哪个|怎么样|有没有|吗\s*$/.test(value) &&
    !/^(?:先|把|给|帮我|请|新建|创建|建|改|删|录|登记|确认|下达|排|送|发|用|填|选|就)/.test(value)
  );
}
/** 只决定任务归属，不决定操作权限或业务授权。模型仍可通过taskControl补充语义判断。 */
export function startsIndependentTask(text: string, current: AssistantBusinessTask | null) {
  if (current && receiptEditMode(text) && /采购|到货|库存|更正/.test(current.goal)) return false;
  if (
    current?.memory?.promptEdit &&
    /润色|修饰|先.*看|再.*看|^(?:好[的，,\s]*)?(?:保存|请保存|允许修改)/.test(text)
  )
    return false;
  if (!current || /^(?:继续|接着|接上|恢复|核验|确认|没问题|好的|按刚才|下一步)/.test(text.trim()))
    return false;
  if (/提示词/.test(text) && !/提示词/.test(current.goal)) return true;
  if (
    /^(?:解释|说明|介绍|查询|查看|统计|汇总|列出|列一下|查一下|看一下|看看|这个.*是什么)/.test(text.trim()) &&
    !/继续(?:处理|生产|执行|完成)/.test(text)
  )
    return true;
  // 问情况的话另起一件事，不要被上一件事没答完的问题卡住。上一件事还在任务记录里。
  if (asksAboutState(text)) return true;
  const action =
    /创建|新建|新增|修改|更改|更新|删除|清空|归档|恢复|导入|采购|订购|生产|送货|发出|发货|入库/.test(
      text,
    );
  if (!action) return false;
  if (current.state === 'completed' || /新任务|另一项|另外.*(?:创建|处理)|永久清空/.test(text))
    return true;
  const before = domains(current.goal),
    next = domains(text);
  return next.length > 0 && before.length > 0 && next.every((d) => !before.includes(d));
}

// 模型的一条助手消息（DeepSeek 工具调用格式）→ 回复对象（正文、是谁在说、要执行的调用）。
// 名字反查回注册表名；名字没声明过、参数不是 JSON 对象的调用列在 rejected 里，绝不执行，
// 进对话前从助手消息里拿掉（原样回传接口可能拒收），改用 system 消息告诉模型。
import type { RawToolCall } from '../../ai/index.js';
import type { AssistantSpeaker } from '../../../shared/assistant/index.js';
import type { ModelReply } from './run-state.js';
import { isRecord } from '../../../shared/core/index.js';

const MARK: Record<string, AssistantSpeaker> = { 小甬: 'yong', 小勒: 'le' };
export const speakerMark = (speaker: AssistantSpeaker) => (speaker === 'le' ? '【小勒】' : '【小甬】');
/** 报错时工具名最多留几个字 */
const NAME_CHARS = 80;

/** 正文开头写错的说话人标记（【小渝】这类，“小”字开头、不是两位里的任何一位）：不认，也不露给人 */
const UNKNOWN_MARK = /^\s*【小[^】\n]{1,3}】[ \t]*\n?/;

/** 正文开头的【小甬】/【小勒】定说话人；以另一位标记开头的段落是接力（最多 2 段）。没有标记时说话人沿用上一位。 */
export function readSpeakerMarks(content: string): {
  message: string;
  speaker?: AssistantSpeaker;
  relay?: { speaker: AssistantSpeaker; text: string }[];
} {
  const parts = content.split(/\n*【(小甬|小勒)】[ \t]*\n?/);
  if (parts.length === 1) return { message: content.replace(UNKNOWN_MARK, '').trim() };
  const speaker = MARK[parts[1]];
  const own = [parts[0].trim()];
  const relay: { speaker: AssistantSpeaker; text: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const text = parts[i + 1].trim();
    if (MARK[parts[i]] === speaker) own.push(text);
    else if (text) relay.push({ speaker: MARK[parts[i]], text });
  }
  return {
    message: own.filter(Boolean).join('\n\n'),
    speaker,
    ...(relay.length ? { relay: relay.slice(0, 2) } : {}),
  };
}

/** registryName：发给模型的名字 → 注册表名字（这一轮发出去的工具）。 */
export function readModelReply(
  message: { content: string; toolCalls: RawToolCall[] },
  registryName: ReadonlyMap<string, string>,
) {
  const reply: ModelReply = { ...readSpeakerMarks(message.content || ''), calls: [] };
  const rejected: { id: string; name: string; reason: string }[] = [];
  for (const call of message.toolCalls) {
    const name = registryName.get(call.function.name);
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      args = undefined;
    }
    if (!name) rejected.push({ id: call.id, name: call.function.name.slice(0, NAME_CHARS), reason: '没有这个工具，没有执行' });
    else if (!isRecord(args)) rejected.push({ id: call.id, name: call.function.name.slice(0, NAME_CHARS), reason: '参数不是合法的 JSON 对象，没有执行' });
    else reply.calls.push({ call: { name, args }, id: call.id });
  }
  return { reply, rejected };
}

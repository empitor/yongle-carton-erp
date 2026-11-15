/**
 * 小甬和小勒。分工只决定谁出面说话，不限制工具，也不改变权限：
 * 权限永远看登录账号。改名字只改这里；性格和分工的文字在可编辑的提示词条目里。
 */
export const assistantSpeakers = ['yong', 'le'] as const;
export type AssistantSpeaker = (typeof assistantSpeakers)[number];
export const speakerNames: Record<AssistantSpeaker, string> = { yong: '小甬', le: '小勒' };
export const speakerPairName = speakerNames.yong + '和' + speakerNames.le;
export const DEFAULT_SPEAKER: AssistantSpeaker = 'yong';

/** 模型可能写代号、中文名或大小写不一致。认不出来就返回空，由调用方兜底，不猜。 */
export function readSpeaker(value: unknown): AssistantSpeaker | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (text === 'yong' || text === 'y' || text === speakerNames.yong) return 'yong';
  if (text === 'le' || text === 'l' || text === speakerNames.le) return 'le';
  return undefined;
}

/** 模型没说清谁在说话时，按最后用到的业务工具判断归谁。通用工具不算数。 */
const toolOwners: Record<string, AssistantSpeaker> = {
  order_import: 'yong',
  inbox: 'yong',
  marks: 'yong',
  overview: 'yong',
  prompts: 'yong',
  arrival: 'le',
  purchase: 'le',
  flow: 'le',
  inventory: 'le',
  finance: 'le',
};
export function speakerForTools(names: readonly string[]): AssistantSpeaker | undefined {
  for (let i = names.length - 1; i >= 0; i--) {
    const owner = toolOwners[names[i].split('.')[0]];
    if (owner) return owner;
  }
  return undefined;
}

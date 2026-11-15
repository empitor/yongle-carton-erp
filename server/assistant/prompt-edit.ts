// 助手改提示词：读（prompts.get）、提出修改（prompts.propose，出确认卡片，卡片上有改之前和改之后的全文）、
// 人点确认后保存并读回核对。复用各模块自己的提示词管理器，不另存一份。
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { promptModules, promptPresetSchema } from '../../shared/ai/index.js';
import type { PromptPresetManager } from '../ai/index.js';
import type { Actor, Store } from '../core/index.js';
import { AppError, audit, requirePermission, requireSuperModeFor } from '../core/index.js';

/** 提出修改时一条提示词最多多少字（和提示词预设单条的上限一样，shared/ai/prompt-presets.ts） */
const PROMPT_ENTRY_CHARS = 16000;
const proposal = z.strictObject({
  module: z.string(),
  presetId: z.uuid(),
  entryId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  content: z.string().trim().min(1).max(PROMPT_ENTRY_CHARS),
});
const readArgs = z.strictObject({ module: z.string().optional(), presetId: z.uuid().optional() });

export const promptTools = [
  {
    name: 'prompts.get',
    risk: 'read',
    description: '读提示词模块和预设，默认读活动预设。助手自己的是 assistant，订单识别是 sales-order，别混。',
    arguments: { module: '可省略，默认assistant；其他模块先查看目录', presetId: '可省略；真实预设UUID' },
    schema: readArgs,
  },
  {
    name: 'prompts.propose',
    risk: 'workflow',
    description: '提出修改一条提示词：先 prompts.get，content 传目标条目改完后的全文。出确认卡片（有前后对比），人确认后才保存。',
    arguments: {
      module: 'get返回模块',
      presetId: '真实UUID',
      entryId: '真实UUID',
      expectedRevision: 'get返回修订',
      content: '完整修改后条目，不是摘要',
    },
    schema: proposal,
  },
] as const;

/** 确认卡片存下来、确认时原样执行的内容 */
const promptChange = proposal.extend({ before: z.string(), presetName: z.string(), entryName: z.string() });
export type PromptChange = z.infer<typeof promptChange>;

export class AssistantPromptEdit {
  readonly managers = new Map<string, PromptPresetManager>();
  constructor(
    private readonly store: Store,
    assistant: PromptPresetManager,
  ) {
    this.managers.set('assistant', assistant);
  }
  private manager(module: string) {
    const manager = this.managers.get(module);
    if (!manager) throw new AppError('该提示词模块未连接：' + module, 503);
    return manager;
  }
  private target(change: Pick<PromptChange, 'module' | 'presetId' | 'entryId'>) {
    const state = this.manager(change.module).view(),
      preset = state.presets.find((p) => p.id === change.presetId),
      entry = preset?.entries.find((e) => e.id === change.entryId);
    if (!preset || !entry) throw new AppError('提示词预设或条目不存在，请重新读取。', 409);
    return { state, preset, entry };
  }
  get(raw: unknown, actor: Actor) {
    requirePermission(actor, 'business:edit');
    const args = readArgs.parse(raw);
    const module = args.module || 'assistant',
      state = this.manager(module).view(),
      presetId = args.presetId || state.activeId;
    if (!state.presets.some((p) => p.id === presetId)) throw new AppError('提示词预设不存在。', 404);
    return {
      module,
      modules: promptModules.map((m) => ({ id: m.id, name: m.name, available: this.managers.has(m.id) })),
      ...state,
      presetDirectory: state.presets.map((p) => ({
        id: p.id,
        name: p.name,
        entries: p.entries.map((e) => ({ id: e.id, name: e.name, enabled: e.enabled })),
      })),
      presets: state.presets.filter((p) => p.id === presetId),
    };
  }
  /** 提出修改：核对目标还是读到的那一版、改完的预设合规，返回卡片上要写的和确认时要存的。 */
  propose(raw: unknown, actor: Actor): PromptChange {
    // 提示词全员共用（进所有人助手的系统提示词）：改它和界面上一样要先进超级管理员模式
    requireSuperModeFor(actor, '保存提示词');
    const args = proposal.parse(raw),
      { state, preset, entry } = this.target(args);
    if (state.revision !== args.expectedRevision) throw new AppError('提示词已变化，请重新读取后再提。', 409);
    promptPresetSchema.parse({
      ...preset,
      entries: preset.entries.map((e) => (e.id === entry.id ? { ...e, content: args.content } : e)),
    });
    return { ...args, before: entry.content, presetName: preset.name, entryName: entry.name };
  }
  moduleName(module: string) {
    return promptModules.find((m) => m.id === module)?.name || module;
  }
  /** 人点了确认：目标条目还是卡片上“改之前”那一版才存，存完读回核对。 */
  save(raw: unknown, actor: Actor) {
    requireSuperModeFor(actor, '保存提示词');
    const change = promptChange.parse(raw);
    const manager = this.manager(change.module),
      { state, preset, entry } = this.target(change);
    if (entry.content !== change.before)
      throw new AppError('这条提示词在出卡片之后被改过了，请重新读取再提。', 409);
    manager.change('save', {
      expectedRevision: state.revision,
      preset: {
        ...preset,
        entries: preset.entries.map((e) => (e.id === entry.id ? { ...e, content: change.content } : e)),
      },
      activate: false,
    });
    const saved = this.target(change);
    if (saved.entry.content !== change.content) throw new AppError('保存后读回的内容对不上。', 409);
    audit(this.store, actor, {
      action: 'assistant-prompt-save',
      entity: 'prompt_presets',
      id: null,
      document: {
        module: change.module,
        presetId: change.presetId,
        entryId: change.entryId,
        revision: saved.state.revision,
        contentHash: createHash('sha256').update(change.content).digest('hex'),
      },
    });
    return {
      verified: true,
      revision: saved.state.revision,
      message: '已保存“' + change.presetName + '”里的“' + change.entryName + '”，并读回核对过。',
    };
  }
}

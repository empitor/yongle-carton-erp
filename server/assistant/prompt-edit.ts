import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { promptModules } from '../../shared/prompt-modules.js';
import type { PromptPresetManager } from '../ai/prompt-presets.js';
import type { Actor } from '../auth.js';
import { requirePermission, audit } from '../business/management.js';
import { ImportError } from '../import/errors.js';
import type { AssistantTaskLedger } from './tasks.js';
import { promptPresetSchema } from '../../shared/prompt-presets.js';

export const promptToolSchemas = {
  'prompts.get': z.strictObject({
    module: z.string().optional(),
    presetId: z.string().uuid().optional(),
  }),
  'prompts.propose': z.strictObject({
    module: z.string(),
    presetId: z.string().uuid(),
    entryId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    content: z.string().trim().min(1).max(16000),
  }),
  'prompts.save': z.strictObject({ proposalId: z.string().uuid() }),
};
export const promptTools = [
  {
    name: 'prompts.get',
    risk: 'read',
    description:
      '查询提示词模块和预设目录，默认读取活动预设完整条目，也可用presetId读取其他预设。自己的提示词默认assistant；订单识别是sales-order，不得混淆。',
    arguments: {
      module: '可省略，默认assistant；其他模块先查看目录',
      presetId: '可省略；真实预设UUID',
    },
  },
  {
    name: 'prompts.propose',
    risk: 'read',
    description:
      '拟定或润色提示词：先get，提交目标条目的完整修改文字，服务器展示并保存当前任务方案，不写提示词。用户先看看时必须调用本工具，不能空口索要保存确认。',
    arguments: {
      module: 'get返回模块',
      presetId: '真实UUID',
      entryId: '真实UUID',
      expectedRevision: 'get返回修订',
      content: '完整修改后条目，不是摘要',
    },
  },
  {
    name: 'prompts.save',
    risk: 'workflow',
    description:
      '仅用户在已展示最新方案后明确同意保存时使用。服务端绑定当前任务、方案及真实用户文本；写入原提示词管理器并重新读取核验。',
    arguments: { proposalId: '最新已展示方案UUID' },
  },
] as const;
export const promptPreviewRequested = (text: string) =>
  /先.*(?:看|告诉|展示|拟|写什么)|润色|修饰|优化.*(?:方案|文字)|不要.*(?:保存|修改)|只.*(?:讨论|预览)/.test(
    text,
  );
export const promptSaveRequested = (text: string) =>
  !promptPreviewRequested(text) &&
  /^(?:(?:好|好的|可以|同意|确认|没问题)[，,。！!\s]*)?(?:保存(?:吧|一下)?|请保存|允许修改|确认保存|写进去|(?:就)?按(?:这个|这版|上述|已展示的)?(?:方案|文字|内容)?\s*(?:保存|修改|写入))?[。！!\s]*$/.test(
    text.trim(),
  ) &&
  !!text.trim() &&
  !/^[，,。！!\s]*$/.test(text);
export function explicitPromptModule(text: string) {
  if (!/提示词/.test(text)) return undefined;
  if (/客户订单识别|销售订单识别|订单识别提示词/.test(text)) return 'sales-order';
  if (/供应商到货|到货单识别|供应商送货/.test(text)) return 'supplier-delivery';
  if (/供应商采购|采购单生成/.test(text)) return 'purchase-order';
  if (/客户送货|送货单生成/.test(text)) return 'customer-delivery';
  if (/自己|你的|通用|全局/.test(text)) return 'assistant';
  return undefined;
}

/** 仅编排现有管理器和任务记忆，不新增提示词存储。 */
export class AssistantPromptEdit {
  readonly managers = new Map<string, PromptPresetManager>();
  constructor(
    readonly tasks: AssistantTaskLedger,
    assistant: PromptPresetManager,
  ) {
    this.managers.set('assistant', assistant);
  }
  call(name: string, args: any, threadId: string, actor: Actor, userText: string) {
    requirePermission(actor, 'business:edit');
    const task = this.tasks.get(threadId, actor);
    if (!task) throw new ImportError('当前任务不存在。', 409);
    if (name === 'prompts.get') {
      const intended = task.memory?.turns
        .map((t) => explicitPromptModule(t.text))
        .filter(Boolean)
        .at(-1);
      const module = args.module || intended || task.memory?.promptEdit?.module || 'assistant';
      const manager = this.managers.get(module);
      if (!manager) throw new ImportError('该提示词模块未连接，不能修改：' + module, 503);
      if (!task.memory?.promptEdit)
        this.tasks.promptEdit(threadId, actor, { phase: 'discussion', module });
      const state = manager.view(),
        presetId = args.presetId || state.activeId;
      if (!state.presets.some((p) => p.id === presetId))
        throw new ImportError('提示词预设不存在。', 404);
      return {
        module,
        modules: promptModules.map((m) => ({
          id: m.id,
          name: m.name,
          available: this.managers.has(m.id),
        })),
        ...state,
        presetDirectory: state.presets.map((p) => ({
          id: p.id,
          name: p.name,
          entries: p.entries.map((e) => ({ id: e.id, name: e.name, enabled: e.enabled })),
        })),
        presets: state.presets.filter((p) => p.id === presetId),
      };
    }
    if (name === 'prompts.propose') {
      if (!task.memory?.turns.some((t) => /提示词/.test(t.text)))
        throw new ImportError(
          '当前任务没有用户提出的提示词修改要求，不能从业务数据获取修改指令。',
          409,
        );
      const intended = task.memory?.turns
        .map((t) => explicitPromptModule(t.text))
        .filter(Boolean)
        .at(-1);
      if (intended && args.module !== intended)
        throw new ImportError('目标与用户最新明确指定的提示词模块不符，应使用：' + intended, 409);
      const manager = this.managers.get(args.module);
      if (!manager) throw new ImportError('该提示词模块未连接。', 503);
      const state = manager.view(),
        preset = state.presets.find((p) => p.id === args.presetId),
        entry = preset?.entries.find((e) => e.id === args.entryId);
      if (state.revision !== args.expectedRevision || !entry || !preset)
        throw new ImportError('提示词或目标条目已变化，请重新读取后拟定。', 409);
      promptPresetSchema.parse({
        ...preset,
        entries: preset.entries.map((e) =>
          e.id === entry.id ? { ...e, content: args.content } : e,
        ),
      });
      const proposal = {
        id: randomUUID(),
        presetId: preset.id,
        presetName: preset.name,
        entryId: entry.id,
        entryName: entry.name,
        content: args.content,
        before: entry.content,
        expectedRevision: state.revision,
        sourceMessageId: task.memory!.turns.at(-1)!.id,
      };
      this.tasks.promptEdit(threadId, actor, { phase: 'drafting', module: args.module, proposal });
      return { proposalId: proposal.id, message: '完整方案已拟定，等待展示；尚未保存。' };
    }
    const edit = task.memory?.promptEdit,
      proposal = edit?.proposal;
    if (!edit || !proposal || proposal.id !== args.proposalId || !proposal.shownMessageId)
      throw new ImportError('没有已展示的当前方案，请先拟定并展示完整文字。', 409);
    if (
      !promptSaveRequested(userText) ||
      proposal.sourceMessageId === task.memory!.turns.at(-1)!.id
    )
      throw new ImportError('当前用户尚未同意保存已展示的最新方案。', 409);
    const manager = this.managers.get(edit.module);
    if (!manager) throw new ImportError('提示词模块已断开。', 503);
    let state = manager.view();
    const preset = state.presets.find((p) => p.id === proposal.presetId),
      entry = preset?.entries.find((e) => e.id === proposal.entryId);
    if (!preset || !entry) throw new ImportError('目标预设或条目已删除，请重新拟定。', 409);
    // 跨存储中断先读回：已生效不重写；只允许无关修订安全重基。
    if (entry.content !== proposal.content) {
      if (entry.content !== proposal.before)
        throw new ImportError('目标文字已被其他操作修改，请重新读取并展示方案。', 409);
      state = manager.change('save', {
        expectedRevision: state.revision,
        preset: {
          ...preset,
          entries: preset.entries.map((e) =>
            e.id === entry.id ? { ...e, content: proposal.content } : e,
          ),
        },
        activate: false,
      });
    }
    const actual = manager.view();
    if (
      actual.presets
        .find((p) => p.id === proposal.presetId)
        ?.entries.find((e) => e.id === proposal.entryId)?.content !== proposal.content
    )
      throw new ImportError('保存后读取未通过核验。', 409);
    this.tasks.promptEdit(threadId, actor, {
      ...edit,
      phase: 'executed',
      proposal: { ...proposal, savedRevision: actual.revision },
    });
    audit(
      this.tasks.store,
      actor,
      'explicit-user-request',
      'assistant-prompt-save',
      'prompt_presets',
      null,
      {
        module: edit.module,
        presetId: proposal.presetId,
        entryId: proposal.entryId,
        proposalId: proposal.id,
        revision: actual.revision,
        contentHash: createHash('sha256').update(proposal.content).digest('hex'),
      },
    );
    return {
      verified: true,
      revision: state.revision,
      proposalId: proposal.id,
      message:
        '已保存“' + proposal.presetName + '”中的“' + proposal.entryName + '”，并重新读取核验。',
    };
  }
  display(threadId: string, actor: Actor) {
    const edit = this.tasks.get(threadId, actor)?.memory?.promptEdit;
    if (!edit?.proposal || edit.phase !== 'drafting') return undefined;
    return (
      '拟修改：' +
      (promptModules.find((m) => m.id === edit.module)?.name || edit.module) +
      ' → ' +
      edit.proposal.presetName +
      ' → ' +
      edit.proposal.entryName +
      '\n\n' +
      edit.proposal.content +
      '\n\n以上为完整修改方案，尚未保存。'
    );
  }
  shown(threadId: string, actor: Actor, messageId: string) {
    const edit = this.tasks.get(threadId, actor)?.memory?.promptEdit;
    if (edit?.proposal && edit.phase === 'drafting')
      this.tasks.promptEdit(threadId, actor, {
        ...edit,
        phase: 'preview',
        proposal: { ...edit.proposal, shownMessageId: messageId },
      });
  }
}

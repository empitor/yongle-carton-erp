import { join } from 'node:path';
import type { PromptPreset } from '../../shared/ai/index.js';
import { promptModules, type PromptModuleId } from '../../shared/ai/index.js';
import { PromptPresetManager } from './prompt-presets.js';

/**
 * 按模块打开各自的提示词库：数据文件按 storageFile 区分，订单、到货、助手的文件路径保持不变，
 * 不会覆盖用户已保存的自定义预设。默认内容由用它的模块提供、调用方（装配）传进来，AI 接入不认识它们。
 */
export function createPromptManagers(
  baseDirectory: string,
  defaults: Record<PromptModuleId, () => PromptPreset>,
): Record<PromptModuleId, PromptPresetManager> {
  const open = (id: PromptModuleId) => {
    const module = promptModules.find((m) => m.id === id);
    if (!module) throw new Error('提示词模块没有登记：' + id);
    return new PromptPresetManager(join(baseDirectory, module.storageFile), defaults[id]);
  };
  return { 'sales-order': open('sales-order'), 'supplier-delivery': open('supplier-delivery'), assistant: open('assistant') };
}

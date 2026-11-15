import { join } from 'node:path';
import type { PromptPreset } from '../../shared/ai/index.js';
import { promptModules, type PromptModuleId } from '../../shared/ai/index.js';
import { PromptPresetManager } from './prompt-presets.js';
import { defaultPromptPreset } from './default-prompts/sales-order.js';
import { supplierDefaultPreset } from './default-prompts/supplier-delivery.js';
import { assistantDefaultPreset } from './default-prompts/assistant.js';

/**
 * 模块标识到默认提示词工厂。每个模块仍沿用现有 PromptPresetManager 架构，
 * 数据文件按 storageFile 区分；既有订单/到货/助手文件路径保持不变，
 * 不会覆盖用户已保存的自定义预设。
 */
const factories: Record<PromptModuleId, () => PromptPreset> = {
  'sales-order': defaultPromptPreset,
  'supplier-delivery': supplierDefaultPreset,
  assistant: assistantDefaultPreset,
};
export function createPromptManagers(baseDirectory: string): Record<PromptModuleId, PromptPresetManager> {
  const open = (id: PromptModuleId) => {
    const module = promptModules.find((m) => m.id === id);
    if (!module) throw new Error('提示词模块没有登记：' + id);
    return new PromptPresetManager(join(baseDirectory, module.storageFile), factories[id]);
  };
  return { 'sales-order': open('sales-order'), 'supplier-delivery': open('supplier-delivery'), assistant: open('assistant') };
}

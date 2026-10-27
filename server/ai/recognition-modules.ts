import { join } from 'node:path';
import type { PromptPreset } from '../../shared/prompt-presets.js';
import { promptModules, type PromptModuleId } from '../../shared/prompt-modules.js';
import { PromptPresetManager } from './prompt-presets.js';
import { defaultPromptPreset } from '../import/default-prompts.js';
import { supplierDefaultPreset } from '../flow/receipt-ai.js';
import { assistantDefaultPreset } from '../assistant/manager.js';
import { purchaseOrderDefaultPreset } from './default-prompts/purchase-order.js';
import { customerDeliveryDefaultPreset } from './default-prompts/customer-delivery.js';

/**
 * 模块标识到默认提示词工厂。每个模块仍沿用现有 PromptPresetManager 架构，
 * 数据文件按 storageFile 区分；既有订单/到货/助手文件路径保持不变，
 * 不会覆盖用户已保存的自定义预设。
 */
const factories: Record<PromptModuleId, () => PromptPreset> = {
  'sales-order': defaultPromptPreset,
  'purchase-order': purchaseOrderDefaultPreset,
  'supplier-delivery': supplierDefaultPreset,
  'customer-delivery': customerDeliveryDefaultPreset,
  assistant: assistantDefaultPreset,
};
export function createPromptManagers(baseDirectory: string) {
  const managers = {} as Record<PromptModuleId, PromptPresetManager>;
  for (const module of promptModules)
    managers[module.id] = new PromptPresetManager(
      join(baseDirectory, module.storageFile),
      factories[module.id],
    );
  return managers;
}

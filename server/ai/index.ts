// 对外接口：别的模块只能从这里引用这个模块
export type { ChatMessage, ChatPart } from './chat.js';
export type { ChatTool, ToolChatMessage, ToolChatResult } from './chat-tools.js';
export type { RawToolCall } from './chat-receiver.js';
export { AiConnectionError } from './errors.js';
export { defaultAiSettingsPath, initializeCredentialProtection, platformProtector } from './credential-store.js';
export type { SecretProtector } from './credential-store.js';
export { retryBadModelOutput } from './model-retry.js';
export { aiPageGuard } from './page-guard.js';
export { PromptPresetManager, defaultPromptSettingsPath } from './prompt-presets.js';
export { promptModuleListRouter, promptSettingsRouter } from './prompt-router.js';
export { createPromptManagers } from './recognition-modules.js';
export { AiSettingsManager } from './settings-manager.js';
export { aiSettingsRouter } from './settings-router.js';
export type { ProviderTokenUsage } from './usage.js';

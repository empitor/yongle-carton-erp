export { assistantDefaultPreset } from './default-prompt.js';
export { AssistantManager } from './manager.js';
export { assistantRouter } from './router.js';
// 发布包验收脚本（scripts/linux/verify-package.mjs）用它核对包里的语音识别能把录音包成 WAV
export { transcribePcm } from './speech/service.js';
export { defaultAssistantToolsPath } from './tool-registry.js';

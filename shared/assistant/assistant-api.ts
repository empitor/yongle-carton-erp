import type { z } from 'zod';
import type { AssistantAttachment, Empty } from '../core/index.js';
import type { MemoryView, memoryAutoSaveBody, memoryContentBody } from './assistant-memory.js';
import type { pageResultBody } from './assistant-page.js';
import type {
  acknowledgedBody,
  cancelUploadBody,
  executeCardBody,
  inventoryPolicyBody,
  pluginSettingBody,
  toolSettingBody,
} from './assistant-requests.js';
import type { AssistantStateView, JsonView, PlanCard, PluginsView, ThreadView, ToolsPage, ToolsView } from './assistant-views.js';

/*
 * 助手的接口表（服务端 server/assistant/router.ts、memory-router.ts、preview-router.ts 用 route() 注册，挂在 /api/assistant 下）。
 * 表的写法见 shared/core/api-table.ts。正文照服务端的 zod 规则的输入写，服务端照样先校验。
 * 不在表里的 5 个地址收发的不是 JSON（语音识别的录音、朗读的音频流、上传附件的原始字节、下载附件原件、一轮回复的事件流），照旧手写。
 */
type Acknowledged = z.input<typeof acknowledgedBody>;

type MemoryApi = {
  'GET /assistant/memory': { response: MemoryView };
  'POST /assistant/memory': { body: z.input<typeof memoryContentBody>; response: MemoryView };
  'POST /assistant/memory/settings': { body: z.input<typeof memoryAutoSaveBody>; response: MemoryView };
  'POST /assistant/memory/clear': { body: Empty; response: MemoryView };
  'POST /assistant/memory/:id': { body: z.input<typeof memoryContentBody>; response: MemoryView };
  'POST /assistant/memory/:id/delete': { body: Empty; response: MemoryView };
};

type PreviewApi = {
  'POST /assistant/previews/:id/inventory-policy': { body: z.input<typeof inventoryPolicyBody>; response: PlanCard };
  'POST /assistant/previews/:id/reject': { body: Empty; response: { rejected: boolean } };
  /** 执行结果是各命令自己的样子 */
  'POST /assistant/previews/:id/execute': { body: z.input<typeof executeCardBody>; response: JsonView };
};

export type AssistantApi = MemoryApi &
  PreviewApi & {
    'GET /assistant': { response: AssistantStateView };
    'POST /assistant/page/results': { body: z.input<typeof pageResultBody>; response: { accepted: boolean } };
    'GET /assistant/plugins': { response: PluginsView & { canManage: boolean } };
    'POST /assistant/plugins/settings': { body: z.input<typeof pluginSettingBody>; response: PluginsView };
    'GET /assistant/tools': { response: ToolsPage };
    'POST /assistant/tools/settings': { body: z.input<typeof toolSettingBody>; response: ToolsView };
    'POST /assistant/threads': { body: Empty; response: ThreadView };
    'GET /assistant/threads/:id': { response: ThreadView };
    'POST /assistant/threads/:id/clear': { body: Acknowledged; response: ThreadView };
    'POST /assistant/threads/:id/delete': { body: Acknowledged; response: { deleted: boolean } };
    'POST /assistant/threads/:id/cancel': { body: Empty; response: { ok: boolean } };
    'POST /assistant/threads/:id/attachments/cancel-upload': { body: z.input<typeof cancelUploadBody>; response: { cancelled: boolean } };
    'POST /assistant/attachments/:id/delete': { body: Acknowledged; response: AssistantAttachment };
  };

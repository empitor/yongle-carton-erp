import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Store } from '../server/db.js';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { AssistantManager, assistantDefaultPreset } from '../server/assistant/manager.js';
import type { AiTransport } from '../server/ai/transport.js';
export const secret = 'sk-fictional-assistant-test-only',
  aes = randomBytes(32),
  protector = {
    protect(s: string) {
      const iv = randomBytes(12),
        c = createCipheriv('aes-256-gcm', aes, iv),
        bytes = Buffer.concat([c.update(s), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), bytes]).toString('base64');
    },
    unprotect(s: string) {
      const b = Buffer.from(s, 'base64'),
        c = createDecipheriv('aes-256-gcm', aes, b.subarray(0, 12));
      c.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString();
    },
  };
export const actor = {
  id: 'fictional-assistant-user',
  name: '虚构AI验收',
  permissions: ['business:edit'],
  role: 'admin' as const,
};
export const superActor = () => ({
  ...actor,
  role: 'super_admin' as const,
  superAdminMode: true,
  superAdminUntil: Date.now() + 120000,
});
export function makeSettings(
  transport: AiTransport,
  apiStyle: 'responses' | 'chat-completions' = 'responses',
) {
  const settings = new AiSettingsManager({ protector, transport });
  let v = settings.saveDraft({
    name: '虚构模型预设',
    endpoint: 'https://api.example.com/v1',
    model: 'test-model',
    apiStyle,
    apiKey: secret,
    expectedRevision: 0,
  });
  settings.activate({ id: v.presets[0].id, expectedRevision: v.revision });
  return settings;
}
export function assistantFixture(replies: any[] = []) {
  let calls = 0;
  const requests: any[] = [],
    settings = makeSettings(async (req) => {
      requests.push(req);
      const reply = replies.shift() || { message: '已查询到服务器实际结果。', toolCalls: [] };
      calls++;
      const response = {
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: JSON.stringify(reply) }],
          },
        ],
      };
      if ((req.body as any).stream) {
        for (const part of [JSON.stringify(reply).slice(0, 35), JSON.stringify(reply).slice(35)])
          req.onSseEvent?.({
            event: 'response.output_text.delta',
            data: JSON.stringify({ type: 'response.output_text.delta', delta: part }),
          });
        req.onSseEvent?.({
          event: 'response.completed',
          data: JSON.stringify({ type: 'response.completed', response }),
        });
        return { status: 200, body: null, streamed: true };
      }
      return { status: 200, body: response };
    }),
    store = new Store(':memory:'),
    prompts = new PromptPresetManager(':memory:', assistantDefaultPreset),
    manager = new AssistantManager(store, settings, prompts);
  return {
    store,
    settings,
    prompts,
    manager,
    replies,
    requests,
    calls: () => calls,
    input: (text: string, requestId: string, context?: any) => ({
      requestId,
      text,
      consent: true,
      profile: settings.view().active,
      context,
    }),
    close() {
      manager.registry.close();
      store.close();
      settings.close();
      prompts.close();
    },
  };
}

// 语音测试的小夹具：带假 DeepSeek 的服务、录音样本。不发真实请求。
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { startHttp } from './http-fixture.js';
import { Store } from '../server/core/db.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { AssistantManager } from '../server/assistant/manager.js';
import { assistantDefaultPreset } from '../server/assistant/default-prompt.js';
import { fakeAiSettings } from './fake-deepseek.js';
import type { AiTransport } from '../server/ai/transport.js';

export const pcm = (values: number[]) => {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer;
};
/** 登录状态里测试要的账号编号 */
const loggedIn = z.object({ actor: z.object({ id: z.string() }) });
/** 0.5 秒的静音（16 kHz） */
export const halfSecond = () => Buffer.alloc(8000 * 2);

/**
 * 起一个带假 DeepSeek 的服务：key 为假时不存密钥；wrap 可以在假 DeepSeek 前面插一层（拦住、记下取消）。
 * 已经建好一个账号并登录，send 带上登录和页面凭证。
 */
export async function speechServer(options: { key?: boolean; wrap?: (t: AiTransport) => AiTransport; asrText?: string } = {}) {
  const { settings, fake } = fakeAiSettings({ asrText: options.asrText ?? '第一句话', wrap: options.wrap, saveKey: options.key !== false });
  const store = new Store(':memory:'),
    manager = new AssistantManager(store, settings, new PromptPresetManager(':memory:', assistantDefaultPreset)),
    h = await startHttp(store, { aiSettings: settings, assistant: manager }),
    { auth, cookie } = h,
    base = h.origin;
  const state: unknown = await (await fetch(base + '/api/auth/state', { headers: { Cookie: cookie } })).json();
  const actorId = loggedIn.parse(state).actor.id;
  const send = (path: string, body: Buffer | object, init: { csrf?: boolean; signal?: AbortSignal } = {}) =>
    fetch(base + '/api/assistant' + path, {
      method: 'POST',
      signal: init.signal,
      headers: {
        Cookie: cookie,
        'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
        ...(init.csrf === false ? {} : { 'X-ERP-Auth-Token': auth.csrf }),
      },
      body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body),
    });
  return {
    fake, settings, store, manager, auth, base, cookie, actorId, send,
    async close() {
      await h.close();
      manager.registry.close();
      store.close();
    },
  };
}

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  presetInputSchema,
  profileSchema,
  type AiProfile,
  type AiSettingsView,
  type ConnectionResult,
  type ApiConnectionState,
  type PresetInput,
  type PublicPreset,
} from '../../shared/ai-settings.js';
import { normalizeProfile } from './endpoint.js';
import { connectCompatible, probeModel, readModelIds, safeConnectionError } from './adapters.js';
import type { AiTransport } from './transport.js';
import { AiConnectionError } from './connection-error.js';
import { completeCompatible, type ChatMessage } from './compatible-chat.js';
import { completeResponses, type ResponseOptions } from './compatible-responses.js';
import { AiWorkQueue } from './work-queue.js';
import { windowsProtector, type SecretProtector } from './credential-store.js';
import {
  SettingsRepository,
  type StoredPreset,
  type SettingsDocument,
} from './settings-repository.js';

const revisionSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative() });
const idSchema = revisionSchema.extend({ id: z.string().uuid() });
const documentSchema = z.strictObject({
  presets: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        name: z.string().min(1).max(60),
        endpoint: z.string().max(500),
        model: z.string().max(160),
        apiStyle: profileSchema.shape.apiStyle,
        encryptedKey: z.string().max(20000).nullable(),
        lastTestAt: z.string().nullable(),
      }),
    )
    .max(50),
  lastPresetId: z.string().uuid().nullable(),
  autoConnect: z.boolean(),
  recognitionConcurrency: z.number().int().min(1).max(6).default(3),
  revision: z.number().int().nonnegative(),
});
type Receipt = {
  input: PresetInput;
  profile: AiProfile;
  secret: string;
  expires: number;
  testedAt: string;
  revision: number;
};
function compatibleProfile(
  input: Pick<PresetInput, 'endpoint' | 'model'> & { apiStyle?: AiProfile['apiStyle'] },
) {
  const apiStyle = input.apiStyle || 'chat-completions';
  const terminal = input.endpoint.trim().replace(/\/+$/, '');
  if (
    (terminal.endsWith('/responses') && apiStyle !== 'responses') ||
    (terminal.endsWith('/chat/completions') && apiStyle !== 'chat-completions')
  )
    throw new AiConnectionError(
      'endpoint',
      'API末尾路径与选择的协议不一致，请填写API根地址或对应协议路径。',
    );
  let endpoint = input.endpoint
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/models$/, '');
  try {
    const url = new URL(endpoint);
    if (!url.pathname || url.pathname === '/') endpoint = url.origin + '/v1';
  } catch {
    /* 地址校验返回中文提示 */
  }
  return normalizeProfile({
    provider: 'compatible',
    endpoint,
    model: input.model || 'not-selected',
    apiStyle,
  });
}
const publicPreset = (p: StoredPreset): PublicPreset => ({
  id: p.id,
  name: p.name,
  endpoint: p.endpoint,
  model: p.model,
  hasApiKey: !!p.encryptedKey,
  lastTestAt: p.lastTestAt,
  apiStyle: p.apiStyle || 'chat-completions',
});

export class AiSettingsManager {
  readonly workQueue = new AiWorkQueue(() => this.document.recognitionConcurrency || 3);
  readonly csrfToken = randomBytes(32).toString('hex');
  private repository: SettingsRepository | null = null;
  private document: SettingsDocument = {
    presets: [],
    lastPresetId: null,
    autoConnect: false,
    revision: 0,
  };
  private storageError: string | null = null;
  private activeId: string | null = null;
  private connection: ApiConnectionState = {
    presetId: null,
    status: 'idle',
    message: '请选择预设或新建 API 连接。',
  };
  private receipts = new Map<string, Receipt>();
  private busy = false;
  private epoch = 0;
  private protector: SecretProtector;
  constructor(
    private readonly options: {
      file?: string;
      legacyFile?: string;
      transport?: AiTransport;
      protector?: SecretProtector;
      minIntervalMs?: number;
      receiptTtlMs?: number;
    } = {},
  ) {
    this.protector = options.protector || windowsProtector;
    try {
      this.repository = new SettingsRepository(options.file || ':memory:');
      const loaded = this.repository.load();
      if (loaded) {
        this.document = documentSchema.parse(loaded);
        if (new Set(this.document.presets.map((p) => p.id)).size !== this.document.presets.length)
          throw new Error();
        for (const p of this.document.presets) compatibleProfile(p);
      } else {
        if (options.legacyFile && existsSync(options.legacyFile)) {
          const old = z
            .object({ version: z.literal(1), profiles: z.array(profileSchema) })
            .parse(JSON.parse(readFileSync(options.legacyFile, 'utf8')));
          for (const p of old.profiles.filter(
            (p) => p.provider === 'compatible' && p.apiStyle !== 'responses',
          )) {
            const normalized = compatibleProfile(p);
            this.document.presets.push({
              id: randomUUID(),
              name: '原有兼容 API',
              endpoint: normalized.endpoint,
              model: p.model,
              encryptedKey: null,
              lastTestAt: null,
            });
          }
          this.document.lastPresetId = this.document.presets[0]?.id || null;
        }
        this.repository.save(this.document);
      }
      this.activeId = this.document.lastPresetId;
      if (this.activeId)
        this.connection = {
          presetId: this.activeId,
          status: 'unverified',
          message: '已恢复配置，尚未验证。',
        };
    } catch {
      this.storageError =
        'AI 配置数据库无法读取或校验失败。已有文件未覆盖，业务数据库不受影响；请检查用户目录权限或恢复 AI 配置备份。';
    }
  }
  close() {
    this.epoch++;
    this.receipts.clear();
    this.repository?.close();
  }
  // 只由受控导入服务调用；密钥始终留在设置管理器内部，不新增凭据读取接口。
  async completeOrderJson(
    messages: ChatMessage[],
    expected: { id: string; endpoint: string; model: string; apiStyle?: AiProfile['apiStyle'] },
    signal?: AbortSignal,
    options: ResponseOptions = {},
  ): Promise<unknown> {
    if (this.storageError) throw new AiConnectionError('storage', this.storageError, 503);
    const p = this.document.presets.find((p) => p.id === this.activeId);
    if (!p || !p.encryptedKey || !p.model)
      throw new AiConnectionError('key_required', '请先在 AI 设置中保存并启用有密钥和模型的预设。');
    if (p.id !== expected.id || p.endpoint !== expected.endpoint || p.model !== expected.model)
      throw new AiConnectionError('stale', '当前 AI 预设已变化，请重新确认外发范围。', 409);
    if ((p.apiStyle || 'chat-completions') !== (expected.apiStyle || 'chat-completions'))
      throw new AiConnectionError('stale', '当前API协议已变化，请重新确认外发范围。', 409);
    return this.workQueue.run(
      () => {
        const active = this.view().active;
        if (
          active?.id !== expected.id ||
          active.endpoint !== expected.endpoint ||
          active.model !== expected.model ||
          (active.apiStyle || 'chat-completions') !== (expected.apiStyle || 'chat-completions')
        )
          throw new AiConnectionError('stale', '排队期间AI预设已变化，请重新确认外发授权。', 409);
        const current = this.document.presets.find((p) => p.id === this.activeId);
        if (!current?.encryptedKey)
          throw new AiConnectionError('key_required', '当前预设密钥已移除。', 409);
        return (current.apiStyle === 'responses' ? completeResponses : completeCompatible)(
          compatibleProfile(current),
          this.protector.unprotect(current.encryptedKey),
          messages,
          this.options.transport,
          signal,
          options,
        );
      },
      signal,
      options.onQueue,
    );
  }
  view(): AiSettingsView {
    const presets = this.document.presets.map(publicPreset);
    return {
      csrfToken: this.csrfToken,
      revision: this.document.revision,
      storage: 'windows-dpapi',
      storageError: this.storageError,
      presets,
      active: presets.find((p) => p.id === this.activeId) || null,
      lastPresetId: this.document.lastPresetId,
      autoConnect: this.document.autoConnect,
      recognitionConcurrency: this.document.recognitionConcurrency || 3,
      connection: { ...this.connection },
    };
  }
  private check(revision: number) {
    if (this.storageError) throw new AiConnectionError('storage', this.storageError, 503);
    if (revision !== this.document.revision)
      throw new AiConnectionError('stale', '设置已在其他页面变更，请刷新后重新操作。', 409);
  }
  private persist(next: SettingsDocument) {
    this.check(this.document.revision);
    try {
      this.repository!.save(
        { ...next, revision: this.document.revision + 1 },
        this.document.revision,
      );
    } catch {
      throw new AiConnectionError(
        'storage',
        '配置保存失败或已被其他实例修改。已有密钥未清空，请检查磁盘权限并刷新页面。',
        503,
      );
    }
    this.document = { ...next, revision: this.document.revision + 1 };
    this.receipts.clear();
    this.epoch++;
  }
  private resolve(raw: unknown, requireModel = false) {
    const input = presetInputSchema.parse(raw);
    this.check(input.expectedRevision);
    const profile = compatibleProfile(input);
    if (requireModel && !input.model)
      throw new AiConnectionError('validation', '请先选择或手动填写模型 ID。');
    const previous = input.id ? this.document.presets.find((p) => p.id === input.id) : undefined;
    if (input.id && !previous)
      throw new AiConnectionError('stale', '此预设已删除，请刷新页面。', 409);
    const supplied = input.apiKey?.trim();
    if (supplied && !/^[\x21-\x7e]+$/.test(supplied))
      throw new AiConnectionError('validation', 'API Key 不能包含空格、换行或非英文字符。');
    const secret =
      supplied ||
      (previous?.endpoint === profile.endpoint && previous.encryptedKey
        ? this.protector.unprotect(previous.encryptedKey)
        : '');
    if (!secret)
      throw new AiConnectionError(
        'key_required',
        '请填写 API Key；修改 API 地址后也需要重新填写。',
      );
    if ([input.name, profile.endpoint, input.model].some((v) => v.includes(secret)))
      throw new AiConnectionError('validation', '密钥只能填写在 API Key 密码框中。');
    const savedCredentials =
      !!previous &&
      !supplied &&
      previous.endpoint === profile.endpoint &&
      (previous.apiStyle || 'chat-completions') === profile.apiStyle;
    return {
      input: { ...input, endpoint: profile.endpoint },
      profile,
      secret,
      previous,
      savedCredentials,
    };
  }
  private async operation<T>(job: () => Promise<T>) {
    if (this.busy) throw new AiConnectionError('busy', '正在连接服务，请稍候再试。', 429);
    this.busy = true;
    try {
      return await job();
    } finally {
      this.busy = false;
    }
  }
  async connect(raw: unknown) {
    const { input, profile, secret, savedCredentials } = this.resolve(raw);
    const epoch = this.epoch;
    return this.operation(async () => {
      try {
        const result = await connectCompatible(profile, secret, this.options.transport);
        this.check(input.expectedRevision);
        const connection = {
          presetId: input.id || null,
          ...result,
          checkedAt: new Date().toISOString(),
        };
        if (epoch === this.epoch && savedCredentials && input.id === this.activeId)
          this.connection = connection;
        return connection;
      } catch (error) {
        const safe = safeConnectionError(error);
        if (epoch === this.epoch && savedCredentials && input.id === this.activeId)
          this.connection = {
            presetId: input.id || null,
            status: 'failed',
            code: safe.code,
            message: safe.message,
          };
        throw safe;
      }
    });
  }
  async models(raw: unknown) {
    const { input, profile, secret } = this.resolve(raw);
    return this.operation(async () => {
      const result = await readModelIds(profile, secret, this.options.transport);
      this.check(input.expectedRevision);
      return result;
    });
  }
  async test(raw: unknown): Promise<ConnectionResult> {
    const { input, profile, secret, savedCredentials, previous } = this.resolve(raw, true);
    return this.operation(async () => {
      const started = Date.now();
      try {
        await probeModel(profile, secret, this.options.transport);
        this.check(input.expectedRevision);
        this.receipts.clear();
        const testToken = randomBytes(32).toString('hex'),
          testedAt = new Date().toISOString();
        this.receipts.set(testToken, {
          input,
          profile,
          secret,
          revision: this.document.revision,
          expires: Date.now() + (this.options.receiptTtlMs ?? 600000),
          testedAt,
        });
        setTimeout(
          () => this.receipts.delete(testToken),
          this.options.receiptTtlMs ?? 600000,
        ).unref();
        const message =
          profile.apiStyle === 'responses'
            ? 'Responses测试成功，已完成真实模型请求。'
            : '模型测试成功，已完成真实聊天补全。';
        if (
          savedCredentials &&
          input.id === this.activeId &&
          input.model === previous?.model &&
          profile.apiStyle === (previous?.apiStyle || 'chat-completions')
        )
          this.connection = {
            presetId: input.id || null,
            status: 'model-tested',
            message,
            checkedAt: testedAt,
          };
        return { ok: true, testedAt, testToken, durationMs: Date.now() - started, message };
      } catch (error) {
        const safe = safeConnectionError(error);
        if (
          input.expectedRevision === this.document.revision &&
          savedCredentials &&
          input.id === this.activeId &&
          input.model === previous?.model &&
          profile.apiStyle === (previous?.apiStyle || 'chat-completions')
        )
          this.connection = {
            presetId: input.id || null,
            status: 'failed',
            code: safe.code,
            message: safe.message,
          };
        throw safe;
      }
    });
  }
  save(raw: unknown) {
    const input = revisionSchema
      .extend({ testToken: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(raw);
    this.check(input.expectedRevision);
    const receipt = this.receipts.get(input.testToken);
    if (!receipt || receipt.expires < Date.now() || receipt.revision !== this.document.revision)
      throw new AiConnectionError(
        'stale',
        '测试凭证过期或配置已变化，请重新测试后保存并启用。',
        409,
      );
    return this.storePreset(receipt.input, receipt.secret, receipt.testedAt, true);
  }
  saveDraft(raw: unknown) {
    const { input, secret, previous } = this.resolve(raw);
    const unchanged =
      previous?.endpoint === input.endpoint &&
      previous.model === input.model &&
      (previous.apiStyle || 'chat-completions') === input.apiStyle &&
      !input.apiKey?.trim();
    return this.storePreset(input, secret, unchanged ? previous.lastTestAt : null, false);
  }
  private storePreset(
    input: PresetInput,
    secret: string,
    lastTestAt: string | null,
    enable: boolean,
  ) {
    const id = input.id || randomUUID();
    if (!input.id && this.document.presets.length >= 50)
      throw new AiConnectionError('validation', '最多保存 50 个预设，请先删除不再使用的预设。');
    const encryptedKey = this.protector.protect(secret);
    const preset: StoredPreset = {
      id,
      name: input.name,
      endpoint: input.endpoint,
      model: input.model,
      apiStyle: input.apiStyle,
      encryptedKey,
      lastTestAt,
    };
    const presets = this.document.presets.filter((p) => p.id !== id).concat(preset);
    this.persist({
      ...this.document,
      presets,
      lastPresetId: enable ? id : this.document.lastPresetId,
    });
    if (enable) {
      this.activeId = id;
      this.connection = {
        presetId: id,
        status: 'model-tested',
        message:
          input.apiStyle === 'responses'
            ? '已保存并启用，Responses模型测试通过。'
            : '已保存并启用，模型聊天补全测试通过。',
        checkedAt: lastTestAt!,
      };
    } else if (this.activeId === id)
      this.connection = {
        presetId: id,
        status: 'unverified',
        message: '预设已更新，请重新连接验证。',
      };
    return this.view();
  }
  activate(raw: unknown) {
    const { id, expectedRevision } = idSchema.parse(raw);
    this.check(expectedRevision);
    const preset = this.document.presets.find((p) => p.id === id);
    if (!preset) throw new AiConnectionError('stale', '预设不存在，请刷新页面。', 409);
    if (!preset.encryptedKey)
      throw new AiConnectionError('key_required', '此预设尚未保存密钥，请填写后保存。');
    this.protector.unprotect(preset.encryptedKey);
    this.persist({ ...this.document, lastPresetId: id });
    this.activeId = id;
    this.connection = {
      presetId: id,
      status: 'unverified',
      message: '已切换预设并恢复配置，尚未验证。点击连接 API 可重新验证。',
    };
    return this.view();
  }
  remove(raw: unknown) {
    const { id, expectedRevision } = idSchema.extend({ confirmed: z.literal(true) }).parse(raw);
    this.check(expectedRevision);
    if (!this.document.presets.some((p) => p.id === id))
      throw new AiConnectionError('stale', '预设已删除，请刷新页面。', 409);
    this.persist({
      ...this.document,
      presets: this.document.presets.filter((p) => p.id !== id),
      lastPresetId: this.document.lastPresetId === id ? null : this.document.lastPresetId,
    });
    if (this.activeId === id) {
      this.activeId = null;
      this.connection = {
        presetId: null,
        status: 'idle',
        message: '当前预设已删除，请选择其他预设。',
      };
    }
    return this.view();
  }
  preferences(raw: unknown) {
    const { expectedRevision, ...preferences } = revisionSchema
      .extend({
        autoConnect: z.boolean().optional(),
        recognitionConcurrency: z.number().int().min(1).max(6).optional(),
      })
      .parse(raw);
    this.check(expectedRevision);
    this.persist({ ...this.document, ...preferences });
    return this.view();
  }
  disable(raw: unknown) {
    const { expectedRevision } = revisionSchema.parse(raw);
    this.check(expectedRevision);
    this.persist({ ...this.document, lastPresetId: null });
    this.activeId = null;
    this.connection = { presetId: null, status: 'idle', message: '已停用 API，预设仍然保留。' };
    return this.view();
  }
  async startup() {
    if (!this.document.autoConnect || !this.document.lastPresetId || this.storageError) return;
    const p = this.document.presets.find((p) => p.id === this.document.lastPresetId);
    if (!p) return;
    this.connection = {
      presetId: p.id,
      status: 'checking',
      message: '已恢复预设，正在后台验证 API；不会执行聊天补全。',
    };
    try {
      await this.connect({
        id: p.id,
        name: p.name,
        endpoint: p.endpoint,
        model: p.model,
        apiStyle: p.apiStyle || 'chat-completions',
        expectedRevision: this.document.revision,
      });
    } catch (error) {
      const safe = safeConnectionError(error);
      if (this.connection.status === 'checking')
        this.connection = {
          presetId: p.id,
          status: 'failed',
          code: safe.code,
          message: safe.message,
        };
    }
  }
}

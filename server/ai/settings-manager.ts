import { randomBytes } from 'node:crypto';
import { ConflictError, StoredDataError } from '../core/index.js';
import { errorMessage } from '../../shared/core/index.js';
import {
  aiKeyDeleteSchema,
  aiKeySchema,
  aiPreferencesSchema,
  aiRevisionSchema,
  CONCURRENCY,
  DEEPSEEK_MODEL,
  type AiBalance,
  type AiKeyCheck,
  type AiSettingsView,
  type AiStatus,
  type DeepSeekVoice,
} from '../../shared/ai/index.js';
import { AiConnectionError, keyRequiredError } from './errors.js';
import type { ChatMessage } from './chat.js';
import { CHAT_FIRST_CONTENT_TIMEOUT_MS, CHAT_IDLE_TIMEOUT_MS, withChatRetry } from './chat-retry.js';
import { completeChatForm, completeChatTools, type ChatTool, type FormOptions, type FormTool, type ToolChatMessage, type ToolChatOptions, type ToolChatResult } from './chat-tools.js';
import { deleteFile, uploadFile, withUploadedFiles, type FilePart, type UploadInput, type UploadedFile } from './files.js';
import { speechToText, textToSpeech, type SpeechAudio } from './speech.js';
import { requestWindow, SEARCH_REQUESTS_PER_SECOND, webFetch, webSearch, type WebSearchResult } from './web.js';
import { getBalance } from './balance.js';
import { deepSeekTransport, type AiTransport } from './transport.js';
import { AiWorkQueue, type QueueState } from './work-queue.js';
import { platformProtector, type SecretProtector } from './credential-store.js';
import { SettingsRepository, type SettingsDocument } from './settings-repository.js';

const CSRF_TOKEN_BYTES = 32;
const emptyDocument = (revision: number): SettingsDocument => ({
  format: 2,
  encryptedKey: null,
  keySavedAt: null,
  recognitionConcurrency: CONCURRENCY.initial,
  revision,
});
const saveFailed = () =>
  new AiConnectionError('storage', 'AI 设置没有保存，已有密钥未清空。请管理员看服务器日志里“[AI 设置]”开头的那条（写着原因），多半是磁盘满或没有写入权限。', 503);
/** 版本号对不上：别的页面或共用同一个库的另一个实例先存过 */
const staleError = () => new AiConnectionError('stale', 'AI 设置已在别处改过，请刷新页面后再操作。', 409);
/** 打开时读不了 AI 设置库：给人看的说法，状态、设置页、每次调用 AI 和保存设置都报这一句 */
const STORAGE_UNREADABLE =
  'AI 设置库读不了，AI 功能暂时不能用，保存设置也会被拒。已有文件没有改动，业务数据不受影响。' +
  '请管理员看服务器日志里“[AI 设置]”开头的那条（写着文件位置和原因）：被别的程序占用就关掉它后重启；' +
  '文件损坏或格式不对就把它移走保存后重启，程序会新建 AI 设置库，再到 设置 → API 配置 重新填写 DeepSeek 密钥。';
/** 日志里写的原因：配置库打不开的提示本身就是中文说明；库里内容对不上的写明哪一项不合 */
const storageReason = (error: unknown) =>
  error instanceof StoredDataError ? error.detail : errorMessage(error);
const missingCheck = (): AiKeyCheck => ({ state: 'missing', message: '还没填写 DeepSeek 密钥。' });
const savedCheck = (): AiKeyCheck => ({ state: 'saved', message: '密钥已加密保存，还没检查。' });

/**
 * AI 接入的总入口：保存一个 DeepSeek 密钥（加密存储），对话、文件、语音、联网都从这里调。
 * 密钥始终留在这里面，不提供读取密钥的接口。
 */
export class AiSettingsManager {
  readonly workQueue = new AiWorkQueue(() => this.document.recognitionConcurrency);
  readonly csrfToken = randomBytes(CSRF_TOKEN_BYTES).toString('hex');
  private repository: SettingsRepository | null = null;
  private document: SettingsDocument = emptyDocument(0);
  private storageError: string | null = null;
  /** 最近一次查余额的结果，只放内存（每次查余额都写库会让设置页的版本号乱跳）。 */
  private check: AiKeyCheck = missingCheck();
  /** 联网搜索的限速窗口：一个进程只有这一个设置实例、一把密钥，几个会话同时搜一起算 */
  private readonly searchSlot = requestWindow(SEARCH_REQUESTS_PER_SECOND);
  private busy = false;
  private protector: SecretProtector;
  private transport: AiTransport;
  /** 重发前怎么等：只有测试换成不等待的 */
  private retryDelay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  constructor(
    options: { file?: string; transport?: AiTransport; protector?: SecretProtector; retryDelay?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
  ) {
    this.protector = options.protector || platformProtector;
    this.transport = options.transport || deepSeekTransport;
    this.retryDelay = options.retryDelay;
    const file = options.file || ':memory:';
    try {
      // 0.8.4 留下的第 1 版库在打开时已经删掉重建（server/core/versioned-sqlite.ts）；读到的不合格式就报错，不覆盖
      this.repository = new SettingsRepository(file);
      const loaded = this.repository.load();
      if (!loaded) this.repository.save(this.document);
      else this.document = loaded;
      if (this.document.encryptedKey) this.check = savedCheck();
    } catch (error) {
      // AI 设置读不了不挡启动；页面上只说是 AI 设置库读不了、该怎么办（不把服务器上的文件路径给页面），
      // 具体是哪个文件、为什么，写进服务端日志给管理员看。
      console.error(`[AI 设置] ${STORAGE_UNREADABLE}\n原因：${storageReason(error)}\n文件：${file}`);
      this.storageError = STORAGE_UNREADABLE;
    }
  }
  close() {
    this.repository?.close();
  }
  private secret(): string {
    if (this.storageError) throw new AiConnectionError('storage', this.storageError, 503);
    if (!this.document.encryptedKey) throw keyRequiredError();
    try {
      return this.protector.unprotect(this.document.encryptedKey);
    } catch {
      throw new AiConnectionError(
        'storage',
        '服务器读不出已保存的 DeepSeek 密钥（换了系统账号或主密钥）。请到 设置 → API 配置 重新填写。',
        503,
      );
    }
  }

  // —— 状态 ——
  status(): AiStatus {
    const ready = !this.storageError && !!this.document.encryptedKey;
    return {
      ready,
      model: DEEPSEEK_MODEL,
      message: this.storageError
        ? this.storageError
        : !ready
          ? '还没填写 DeepSeek 密钥。请管理员到 设置 → API 配置 填写。'
          : this.check.state === 'invalid' || this.check.state === 'low-balance' || this.check.state === 'failed'
            ? this.check.message
            : '可以使用。',
    };
  }
  view(): AiSettingsView {
    return {
      csrfToken: this.csrfToken,
      revision: this.document.revision,
      model: DEEPSEEK_MODEL,
      hasKey: !!this.document.encryptedKey,
      keySavedAt: this.document.keySavedAt,
      check: { ...this.check },
      recognitionConcurrency: this.document.recognitionConcurrency,
      storageError: this.storageError,
    };
  }
  /** 只验证本机解密权限，不输出密钥。 */
  credentialWarning() {
    if (this.storageError) return this.storageError;
    if (!this.document.encryptedKey) return;
    try {
      this.protector.unprotect(this.document.encryptedKey);
    } catch {
      return '当前服务账号或平台无法解密已保存的 AI 密钥，请在此账号下重新填写。';
    }
  }

  // —— 设置 ——
  private checkRevision(revision: number) {
    if (this.storageError) throw new AiConnectionError('storage', this.storageError, 503);
    if (revision !== this.document.revision) throw staleError();
  }
  private persist(next: Omit<SettingsDocument, 'revision'>) {
    const revision = this.document.revision;
    // 配置库没打开时 checkRevision 已经按读不了拦下，这里照保存失败说
    if (!this.repository) throw saveFailed();
    try {
      this.repository.save({ ...next, revision: revision + 1 }, revision);
    } catch (error) {
      if (error instanceof ConflictError) {
        // 共用同一个库的另一个实例先存过：读回库里的最新内容，页面刷新后拿到新版本号就能接着存
        this.reload(this.repository);
        throw staleError();
      }
      console.error(`[AI 设置] 设置没有保存：${storageReason(error)}\n文件：${this.repository.file}`);
      throw saveFailed();
    }
    this.document = { ...next, revision: revision + 1 };
  }
  private reload(repository: SettingsRepository) {
    const latest = repository.load();
    if (!latest) return;
    if (latest.encryptedKey !== this.document.encryptedKey) this.check = latest.encryptedKey ? savedCheck() : missingCheck();
    this.document = latest;
  }
  private async operation<T>(job: () => Promise<T>) {
    if (this.busy) throw new AiConnectionError('busy', '正在检查密钥，请稍候再试。', 429);
    this.busy = true;
    try {
      return await job();
    } finally {
      this.busy = false;
    }
  }
  /** 查余额并记下结果：401 记“密钥不对”，402 记“余额不足”，别的记“连不上”。 */
  private async probe(key: string, signal?: AbortSignal): Promise<AiBalance> {
    const checkedAt = new Date().toISOString();
    try {
      const balance = await getBalance(this.transport, key, signal);
      this.check = balance.available
        ? { state: 'ok', message: '可以使用。', checkedAt }
        : {
            state: 'low-balance',
            code: 'quota',
            message: 'DeepSeek 余额不足，识别、助手、语音都会失败。请到 DeepSeek 开放平台充值。',
            checkedAt,
          };
      return balance;
    } catch (error) {
      if (error instanceof AiConnectionError)
        this.check =
          error.code === 'authentication'
            ? { state: 'invalid', code: error.code, message: error.message, checkedAt }
            : error.code === 'quota'
              ? { state: 'low-balance', code: error.code, message: error.message, checkedAt }
              : { state: 'failed', code: error.code, message: error.message, checkedAt };
      throw error;
    }
  }
  private keyInput(raw: unknown) {
    const input = aiKeySchema.parse(raw);
    this.checkRevision(input.expectedRevision);
    if (!/^[\x21-\x7e]+$/.test(input.apiKey))
      throw new AiConnectionError('validation', 'API Key 不能包含空格、换行或中文字符。');
    return input;
  }
  private storeKey(apiKey: string) {
    this.persist({
      ...this.document,
      encryptedKey: this.protector.protect(apiKey),
      keySavedAt: new Date().toISOString(),
    });
  }
  /** 只保存不测试（设置页“更多”里）。 */
  saveKey(raw: unknown): AiSettingsView {
    const input = this.keyInput(raw);
    if (this.busy) throw new AiConnectionError('busy', '正在检查密钥，请稍候再试。', 429);
    this.storeKey(input.apiKey);
    this.check = savedCheck();
    return this.view();
  }
  /** 保存并测试：先用新密钥查余额，密钥不对、连不上都不保存；余额不足照样保存。 */
  async saveAndTestKey(raw: unknown): Promise<AiSettingsView & { balance?: AiBalance }> {
    const input = this.keyInput(raw);
    return this.operation(async () => {
      let balance: AiBalance | undefined;
      const previous = this.check;
      try {
        balance = await this.probe(input.apiKey);
      } catch (error) {
        if (!(error instanceof AiConnectionError && error.code === 'quota')) {
          // 没保存：状态留给已存的那把密钥
          this.check = previous;
          throw error;
        }
      }
      this.checkRevision(input.expectedRevision);
      this.storeKey(input.apiKey);
      return { ...this.view(), ...(balance ? { balance } : {}) };
    });
  }
  /** 用已存的密钥查余额（免费）。 */
  async testKey(raw: unknown): Promise<AiSettingsView & { balance: AiBalance }> {
    const { expectedRevision } = aiRevisionSchema.parse(raw);
    this.checkRevision(expectedRevision);
    return this.operation(async () => {
      const balance = await this.probe(this.secret());
      return { ...this.view(), balance };
    });
  }
  async balance(signal?: AbortSignal): Promise<AiBalance> {
    return this.probe(this.secret(), signal);
  }
  removeKey(raw: unknown): AiSettingsView {
    const { expectedRevision } = aiKeyDeleteSchema.parse(raw);
    this.checkRevision(expectedRevision);
    this.persist({ ...this.document, encryptedKey: null, keySavedAt: null });
    this.check = missingCheck();
    return this.view();
  }
  preferences(raw: unknown): AiSettingsView {
    const { expectedRevision, recognitionConcurrency } = aiPreferencesSchema.parse(raw);
    this.checkRevision(expectedRevision);
    this.persist({ ...this.document, recognitionConcurrency });
    return this.view();
  }

  // —— 调用（各接口在自己的文件里，这里只补上密钥和排队） ——
  /** 识别“填表”：指定模型必须调这一个工具，交回填好的表（还没校验）。所有调用共用识别并发数排队，只有明确限流才在排队那一层自动重试。 */
  async fillForm(
    messages: ChatMessage[],
    form: FormTool,
    signal?: AbortSignal,
    options: FormOptions & { onQueue?: (state: QueueState) => void } = {},
  ): Promise<unknown> {
    this.secret();
    const { onQueue, ...chat } = options;
    return this.workQueue.run(() => completeChatForm(this.secret(), messages, form, this.transport, { ...chat, signal }), signal, onQueue);
  }
  /**
   * 原生工具调用的对话（助手用）。和识别共用排队、传输和报错；流式回复长时间没有新内容就断开；
   * 断线、上游内部出错、空闲超时、空回复自动原样重发（chat-retry.ts），onRetry 在每次重发前告诉调用方。
   */
  async completeChatTools(
    messages: ToolChatMessage[],
    tools: ChatTool[],
    signal?: AbortSignal,
    options: ToolChatOptions & { onQueue?: (state: QueueState) => void; onRetry?: (attempt: number, error: AiConnectionError) => void } = {},
  ): Promise<ToolChatResult> {
    this.secret();
    const { onQueue, onRetry, ...chat } = options;
    return withChatRetry(
      () =>
        this.workQueue.run(
          () => completeChatTools(this.secret(), messages, tools, this.transport, { idleTimeoutMs: CHAT_IDLE_TIMEOUT_MS, firstContentTimeoutMs: CHAT_FIRST_CONTENT_TIMEOUT_MS, ...chat, signal }),
          signal,
          onQueue,
        ),
      signal,
      onRetry,
      this.retryDelay,
    );
  }
  async uploadFile(input: UploadInput, opts?: { signal?: AbortSignal; expiresSeconds?: number }): Promise<UploadedFile> {
    return uploadFile(this.transport, this.secret(), input, opts);
  }
  async deleteFile(id: string, signal?: AbortSignal): Promise<void> {
    return deleteFile(this.transport, this.secret(), id, signal);
  }
  async withUploadedFiles<T>(
    files: UploadInput[],
    job: (parts: FilePart[], uploaded: UploadedFile[]) => Promise<T>,
    opts?: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
  ): Promise<T> {
    const key = this.secret();
    const api = {
      upload: (input: UploadInput, o: { signal?: AbortSignal; expiresSeconds?: number }) => uploadFile(this.transport, key, input, o),
      remove: (id: string) => deleteFile(this.transport, key, id),
    };
    return withUploadedFiles(api, files, job, {
      ...opts,
      onCleanupFailure: (count) => console.warn(`有 ${count} 个上传到 DeepSeek 的文件没删掉，1 小时后自动过期。`),
    });
  }
  async speechToText(wav: Buffer, signal?: AbortSignal): Promise<{ text: string; durationMs: number }> {
    return speechToText(this.transport, this.secret(), wav, signal);
  }
  async textToSpeech(text: string, opts: { signal: AbortSignal; voice?: DeepSeekVoice; format?: 'pcm' | 'wav' }): Promise<SpeechAudio> {
    return textToSpeech(this.transport, this.secret(), text, opts);
  }
  async webSearch(input: { query: string; count: number; originalQuestion?: string }, signal?: AbortSignal): Promise<WebSearchResult[]> {
    return webSearch(this.transport, this.secret(), input, this.searchSlot, signal);
  }
  async webFetch(url: string, signal?: AbortSignal): Promise<{ url: string; title: string; content: string }> {
    return webFetch(this.transport, this.secret(), url, signal);
  }
}

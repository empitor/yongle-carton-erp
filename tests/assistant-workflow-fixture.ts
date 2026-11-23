// 聊天里识别导入订单的夹具：文件库（临时目录）、导入管理器、助手，模型替身按用户这句话调识别或正式导入。
import { sales } from '../server/sales/index.js';
import { executeImports, importCard } from '../server/assistant/order-import-card.js';
import type { OrderImportState, WorkflowContext } from '../server/assistant/order-import-state.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/core/db.js';
import { AssistantManager } from '../server/assistant/manager.js';
import type { AgentOptions } from '../server/assistant/chat/agent-config.js';
import type { ImportManager } from '../server/import/manager.js';
import { ReceiptAi } from '../server/import/receipt-ai.js';
import { assistantDeps, eventData, promptTable } from './assistant-fixture.js';
import { testImports } from './order-import-fixture.js';
import { fakeAiSettings, freshUserText, httpError, turnFailure } from './fake-deepseek.js';
import type { ChatBody, ChatCall } from './fake-deepseek-wire.js';
import { imageFixture } from './import-fixtures.js';
import type { AiSettingsManager } from '../server/ai/settings-manager.js';
import type { AiTransport } from '../server/ai/transport.js';
import { customerSchema, productSchema, today } from '../shared/core/domain.js';
import type { Actor } from '../server/core/index.js';
import { actor as baseActor, grant } from './actor-fixture.js';

/** 能识别导入的账号 */
export const importer = { ...baseActor, permissions: grant('business:edit', 'import:execute') };
const actor = importer;
/** 识别结果：两行、单价四位小数、写明的合计 */
export const workflowAnalysis = () => ({
  header: {
    buyerName: '聊天验收客户',
    supplierName: '宁波甬勒包装制品有限公司',
    orderDate: today(),
    deliveryDate: today(),
    currency: '人民币',
    statedTotalQuantity: '200',
    statedTotalAmount: '246.90',
  },
  lines: ['聊天纸箱甲', '聊天纸箱乙'].map((name, i) => ({
    productName: name,
    specification: i ? '200×150×100' : '300×200×150',
    quantity: '100',
    unit: '只',
    unitPrice: '1.2345',
    statedAmount: '123.45',
  })),
  warnings: [],
});
/** 正式导入：出卡片、确认两步合在一起，给直接调流程函数的测试用（聊天里是助手出卡片、人点确认） */
export async function importOrders(wf: OrderImportState, ctx: WorkflowContext, args: { taskId?: string; workspaceIds?: string[] } = {}) {
  const card = await importCard(wf, ctx, args);
  return executeImports(wf, ctx, card.args.imports);
}
/** 模型替身的状态：记下的请求、排队的回答（可以是现算回答的函数）、识别调用次数、识别是否故障 */
type ModelStandIn = { requests: ChatCall[]; replies: unknown[]; recognitionCalls: number; broken: boolean };
const isThunk = (v: unknown): v is () => unknown => typeof v === 'function';

/** 这一轮第一次问模型时，按用户这句话决定调哪个工具 */
function controlReply(body: ChatBody) {
  const text = freshUserText(body);
  if (text !== null) {
    if (/确认导入/.test(text)) return { message: '调用正式导入服务', toolCalls: [{ name: 'order_import.execute', args: {} }] };
    if (/识别.*订单|订单.*识别/.test(text) && !/只阅读|解释|是什么/.test(text))
      return { message: '调用订单识别服务', toolCalls: [{ name: 'order_import.start', args: { recognitionType: 'order' } }] };
  }
  // 这一轮有调用没做成：替身把服务器交给它的原因说出来（真模型会用自己的话转述）
  const failure = turnFailure(body);
  if (failure) return { message: '没做成：' + failure, toolCalls: [] };
  return { message: '已读取识别结果，未执行其他修改。', toolCalls: [] };
}

/** 接上模型替身的设置：助手对话按 replies 或 controlReply 回答，识别一律回 workflowAnalysis */
function standInSettings(model: ModelStandIn, wrap?: (t: AiTransport) => AiTransport) {
  return fakeAiSettings({
    wrap,
    chat: (body, call) => {
      model.requests.push(call);
      const global = JSON.stringify(body).includes('ERP 里的业务助手小甬和小勒');
      if (!global) {
        model.recognitionCalls++;
        // 普通上游错误：识别类不自动重发（503、429 算限流，会按秒退避重试）
        if (model.broken) return httpError(500);
      }
      const next = global ? model.replies.shift() || controlReply(body) : workflowAnalysis();
      return isThunk(next) ? next() : next;
    },
  }).settings;
}

type Reviewed = { poNumber: string; buyerName?: string; newCustomer?: boolean; file?: Buffer; name?: string };
/**
 * 页面上人工上传、识别、核对过的一份：填了订单号（buyerName 给了也改客户名），产品按名称对上（没有就建），
 * 客户对上已有的第一个，newCustomer 时选“新建”。文件默认是图片后面接上订单号（每份内容不同）。
 */
async function reviewWorkspace(store: Store, imports: ImportManager, o: Reviewed) {
  const file = o.file ?? Buffer.concat([imageFixture(), Buffer.from(o.poNumber)]);
  let w = (await imports.upload(file, o.name ?? o.poNumber + '.png', true)).workspace;
  w = await imports.analyze(w.id, { expectedRevision: w.revision }, undefined, actor);
  const header = (field: string, value: string) => ({ op: 'set-header' as const, field, value, reason: '虚构人工核对' });
  const operations = [header('purchaseOrderNumber', o.poNumber), ...(o.buyerName ? [header('buyerName', o.buyerName)] : [])];
  w = imports.edit(w.id, { expectedRevision: w.revision, operations }, 'manual', actor);
  if (!w.draft) throw new Error('识别以后没有识别结果');
  const products = Object.fromEntries(
    w.draft.lines.map((line) => {
      const name = line.fields.productName.value;
      if (name === null) throw new Error('识别结果里有一行没有产品名');
      const p = sales(store).products().find((p) => p.name === name) || sales(store).createProduct(productSchema.parse({ name }));
      return [line.id, { mode: 'existing' as const, id: p.id, version: p.version }];
    }),
  );
  const c = sales(store).customers()[0];
  const customer = o.newCustomer ? { mode: 'new' as const } : { mode: 'existing' as const, id: c.id, version: c.version };
  return imports.mapping(w.id, { expectedRevision: w.revision, mapping: { customer, products, roundingPolicy: 'exact-cents' } }, actor);
}

/** 助手的全套依赖：识别导入（原件在临时目录）、到货识别、三个提示词模块，彼此用的是同一份 */
function workflowDeps(store: Store, dir: string, settings: AiSettingsManager, receiptSettings: AiSettingsManager) {
  const prompts = promptTable();
  const receiptAi = new ReceiptAi(store, receiptSettings, prompts['supplier-delivery']);
  const imports = testImports({
    store,
    directory: join(dir, 'imports'),
    archiveDirectory: join(dir, 'archive'),
    settings,
    promptPresets: prompts['sales-order'],
    receiptAi,
  });
  return { prompts, imports, built: assistantDeps(store, settings, { prompts, receiptAi, imports }) };
}

/**
 * options.settings：传进来就用它（预览实例的“真实模型”模式），不装模型替身，replies 不起作用。
 * options.agent：不给就和真实的一样（正式导入只出确认卡片）；只测识别导入流程本身的测试传 { autoConfirm: true }。
 * options.wrap：在假 DeepSeek 前面插一层（预览实例用它把识别的回复放慢，界面上看得到进度一步步出来）。
 * options.receiptSettings：到货识别另用的设置（预览实例的送货单替身）；不给就和订单识别同一个。
 */
export function createOrderWorkflowFixture(
  databasePath?: string,
  options: {
    settings?: AiSettingsManager;
    agent?: AgentOptions;
    wrap?: (t: AiTransport) => AiTransport;
    receiptSettings?: AiSettingsManager;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'erp-assistant-orders-')),
    store = new Store(databasePath || join(dir, 'erp.sqlite'));
  const model: ModelStandIn = { requests: [], replies: [], recognitionCalls: 0, broken: false };
  const settings = options.settings || standInSettings(model, options.wrap);
  const { prompts, imports, built } = workflowDeps(store, dir, settings, options.receiptSettings ?? settings),
    { execution } = built.deps,
    manager = new AssistantManager(built.deps, { agent: options.agent });
  sales(store).createCustomer(customerSchema.parse({ name: '聊天验收客户' }));
  const thread = manager.create(actor),
    events: { event: string; data: Record<string, unknown> }[] = [];
  const send = (text: string, attachmentIds: string[] = [], requestId = randomUUID(), who: Actor = actor) =>
    manager.chat(thread.id, { text, attachmentIds, requestId }, who, 'session', (event, data) => events.push({ event, data: eventData.parse(data) }), () => who);
  const current = () => {
    const state = manager.view(thread.id, actor).orderWorkflow;
    const task = state?.tasks.find((t) => t.id === state.activeId);
    if (!task) throw new Error('这个会话里还没有正在识别的订单');
    return imports.get(task.workspaceId);
  };
  /** 直接调流程函数时的上下文（默认这个会话、能导入的账号） */
  const ctx = (over: Partial<WorkflowContext> = {}): WorkflowContext => ({
    threadId: thread.id,
    actor,
    requestId: randomUUID(),
    files: [],
    check: () => actor,
    signal: new AbortController().signal,
    emit: () => {},
    ...over,
  });
  const reviewedWorkspace = (o: Reviewed) => reviewWorkspace(store, imports, o);
  const { replies, requests } = model;
  return {
    dir,
    store,
    settings,
    manager,
    /** 建助手用的全套依赖（三个提示词模块的表、到货识别……） */
    deps: built.deps,
    imports,
    execution,
    thread,
    replies,
    requests,
    events,
    send,
    current,
    ctx,
    reviewedWorkspace,
    recognitionCalls: () => model.recognitionCalls,
    broken: (v: boolean) => (model.broken = v),
    close() {
      manager.registry.close();
      built.close();
      imports.close();
      for (const prompt of Object.values(prompts)) prompt.close();
      settings.close();
      store.close();
      // Windows 上杀毒扫描会短暂占住刚建的 SQLite 文件，删目录要重试几次
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

import { productionCompletionSchema } from '../../shared/assistant-production.js';
import { pageActionSchema, pageObserveSchema } from '../../shared/assistant-page.js';
import { browserActionSchema } from '../../shared/assistant-browser.js';
import {
  builtinPlugins,
  builtinPluginFor,
  type PluginManifest,
  type PluginTool,
} from './plugins.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { toolCatalog, assistantModules } from './tools.js';
import { navigationTargets, erpPageIds } from '../../shared/assistant-navigation.js';
import { patchOperationSchema } from '../../shared/order-draft.js';
import { ImportError } from '../import/errors.js';
import type { Actor } from '../auth.js';
import { requirePermission, isSuperMode } from '../business/management.js';
import { taskPlanSchema } from '../../shared/assistant-task.js';
import { developerCommandSchema, developerModules } from '../../shared/developer.js';
import { assistantManagementSchema } from '../../shared/assistant-management.js';
import { developmentResetSchema } from '../../shared/assistant-development-reset.js';
import { requireDeveloper, isLocalAdministrator } from '../developer-capability.js';
import { workspaceCommandSchema } from '../workspace-management.js';
import { deletionSelection } from '../business/database-maintenance.js';
import { promptToolSchemas } from './prompt-edit.js';
import { receiptCorrectionPreviewSchema, receiptCorrectionSchema } from '../../shared/operations.js';
import { flowScheduleSchema } from '../../shared/physical-flow.js';
import { arrivalQuerySchema, arrivalPlanInputSchema, arrivalAiReceiveSchema } from '../../shared/arrival.js';
import { dailyQuerySchema } from '../flow/daily.js';
import { documentExportSchema } from '../../shared/business-export.js';

const positive = z.number().int().positive(),
  uuid = z.string().uuid();
const task = { taskId: uuid.optional() },
  module = z.enum(assistantModules);
const schemas: Record<string, z.ZodType> = {
  'documents.templates':z.strictObject({}),
  'flow.daily': dailyQuerySchema,
  'documents.preview': z.strictObject({kind:z.enum(['purchase','delivery']),id:positive,templateId:z.string().regex(/^(purchase|delivery)-[a-z0-9-]{1,60}$/).optional()}),
  'documents.status': z.strictObject({exportId:uuid}),
  'documents.export': documentExportSchema,
  'arrival.records': arrivalQuerySchema,
  'arrival.plans': arrivalQuerySchema,
  'arrival.plan.save': arrivalPlanInputSchema,
  'arrival.receive': arrivalAiReceiveSchema,
  'purchase.receipt.data_edit_preview': receiptCorrectionPreviewSchema.extend({ mode: z.literal('data-edit').default('data-edit'), purchaseId: positive, receiptId: z.string().min(1).max(150) }),
  'purchase.receipt.data_edit': receiptCorrectionSchema.extend({ mode: z.literal('data-edit').default('data-edit'), purchaseId: positive, receiptId: z.string().min(1).max(150) }),
  'flow.schedule': flowScheduleSchema.extend({ id: positive }),
  'purchase.receipt.preview': receiptCorrectionPreviewSchema.extend({ purchaseId: positive, receiptId: z.string().min(1).max(150) }),
  'purchase.receipt.correct': receiptCorrectionSchema.extend({ purchaseId: positive, receiptId: z.string().min(1).max(150) }),
  ...promptToolSchemas,
  'browser.capture': z.strictObject({}),
  'browser.act': browserActionSchema,
  'page.observe': pageObserveSchema,
  'page.verify': z.strictObject({
    stepIds: z.array(uuid).min(1).max(10),
    module: module.optional(),
    id: positive.optional(),
    expected: z.record(z.string(), z.unknown()).optional(),
  }),
  'page.act': pageActionSchema.refine(
    (v) => !v.outcome || module.safeParse(v.outcome.module).success,
    '核验目标模块不合法',
  ),
  'task.plan': taskPlanSchema,
  'task.get': z.strictObject({}),
  'task.activate': z.strictObject({ taskId: uuid }),
  'task.finish': z.strictObject({}),
  'developer.execute': developerCommandSchema,
  'management.execute': assistantManagementSchema,
  'management.reset': developmentResetSchema,
  'management.delete_preview': deletionSelection,
  'records.delete': z.strictObject({
    module,
    id: positive,
    inventoryPolicy: z.enum(['preserve', 'recalculate']).optional(),
  }),
  'management.workspaces': z.union([
    z.strictObject({ action: z.literal('list'), requestId: uuid.optional() }),
    workspaceCommandSchema,
  ]),
  'management.context': z.strictObject({ module: z.enum(developerModules), id: positive }),
  'attachments.read': z.strictObject({
    question: z.string().trim().min(1).max(4000),
    attachmentIds: z.array(uuid).min(1).max(6).optional(),
  }),
  'ui.open': z.strictObject({
    page: z.enum(erpPageIds as [string, ...string[]]).optional(),
    module: z.enum(navigationTargets as [string, ...string[]]).optional(),
    id: positive.optional(),
    q: z.string().max(100).optional(),
  }),
  'overview.get': z.strictObject({
    start: z.string().optional(),
    end: z.string().optional(),
    months: z.number().int().min(1).max(3).optional(),
    allDates: z.boolean().optional(),
  }),
  'records.search': z.strictObject({
    module,
    describe: z.boolean().optional(),
    filters: z.record(z.string(), z.unknown()).optional(),
    limit: z.number().int().min(1).max(20).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  'records.summarize': z.strictObject({
    module,
    allocation: z
      .strictObject({
        orderId: positive,
        unitsPerSheet: positive,
        mode: z.enum(['per-product', 'shared']),
      })
      .optional(),
    filters: z.record(z.string(), z.unknown()).optional(),
  }),
  'records.get': z.strictObject({
    module,
    id: z.union([positive, uuid]),
    lifecycle: z.enum(['active', 'archived', 'all']).optional(),
  }),
  'records.propose_save': z.strictObject({
    module,
    id: positive.optional(),
    patch: z.record(z.string(), z.unknown()),
    previewOnly: z.boolean().optional(),
  }),
  'records.propose_lifecycle': z.strictObject({
    module,
    id: positive,
    action: z.enum(['archive', 'restore']),
    previewOnly: z.boolean().optional(),
  }),
  'records.propose_batch_lifecycle': z.strictObject({
    module,
    ids: z.array(positive).min(1).max(100),
    action: z.enum(['archive', 'restore']),
  }),
  'records.propose_permanent_delete': z.strictObject({ module, id: positive }),
  'flow.propose_cancel': z.strictObject({
    id: positive,
    reason: z.string().min(1).max(1000),
    previewOnly: z.boolean().optional(),
  }),
  'flow.propose_production_completion': productionCompletionSchema,
  'flow.propose_confirmation': z.strictObject({ id: positive }),
  'flow.propose_reversal': z.strictObject({ id: positive, reason: z.string().min(1).max(1000) }),
  'inventory.propose_movement': z.strictObject({
    id: positive,
    action: z.enum(['in', 'out', 'adjust']),
    quantity: z.string(),
    date: z.string(),
    notes: z.string(),
  }),
  'purchase.propose_receipt': z.strictObject({
    id: positive,
    reference: z.string(),
    date: z.string(),
    items: z.array(z.strictObject({ lineId: positive, quantity: z.string() })).min(1),
    notes: z.string().optional(),
  }),
  'order_import.list': z.strictObject({}),
  'order_import.attach': z.strictObject({ workspaceId: uuid }),
  'order_import.execute_many': z.strictObject({ workspaceIds: z.array(uuid).min(1).max(6) }),
  'order_import.start': z.strictObject({
    attachmentIds: z.array(uuid).max(6).optional(),
    recognitionType: z.enum(['order', 'arrival']).default('order'),
  }),
  'order_import.get': z.strictObject(task),
  'order_import.select': z.strictObject({ taskId: uuid }),
  'order_import.edit': z.strictObject({
    ...task,
    expectedRevision: z.number().int(),
    operations: z.array(patchOperationSchema).min(1).max(100),
  }),
  'order_import.match': z.strictObject({
    ...task,
    customerId: positive.optional(),
    line: positive.optional(),
    productId: positive.optional(),
    productCode: z.string().min(1).max(100).optional(),
    createNew: z.boolean().optional(),
  }),
  'order_import.preview': z.strictObject(task),
  'order_import.execute': z.strictObject(task),
  'order_import.retry': z.strictObject(task),
  'order_import.undo': z.strictObject(task),
};
export const defaultAssistantToolsPath = () =>
  fileURLToPath(new URL('../../data/ai-tools/tools.sqlite', import.meta.url));
export type ToolKind = 'read' | 'business' | 'workflow';
/** 注册定义、持久启停与调度共用同一目录；业务规则仍由原服务验证。 */
export class AssistantToolRegistry {
  readonly db: DatabaseSync;
  private closed = false;
  private readonly plugins = new Map(builtinPlugins.map((p) => [p.id, p]));
  private readonly definitions = new Map<string, PluginTool & { pluginId: string }>(
    toolCatalog.map((t) => {
      if (!schemas[t.name]) throw new Error('工具缺少参数结构：' + t.name);
      return [
        t.name,
        {
          ...t,
          ...(t.name.startsWith('prompts.') ? { permissions: ['business:edit'] } : {}),
          ...(t.name === 'browser.act' ? { capability: 'page' as const } : {}),
          pluginId: builtinPluginFor(t.name),
          kind: (t.risk === 'workflow'
            ? 'workflow'
            : t.risk === 'read'
              ? 'read'
              : 'business') as ToolKind,
          schema:
            !['read', 'workflow'].includes(t.risk) && schemas[t.name] instanceof z.ZodObject
              ? (schemas[t.name] as z.ZodObject<any>).safeExtend({
                  previewOnly: z.boolean().optional(),
                })
              : schemas[t.name],
        },
      ];
    }),
  );
  constructor(
    file = ':memory:',
    private workflowReady = () => false,
  ) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      'PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS tool_settings(name TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tool_settings_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL); INSERT OR IGNORE INTO tool_settings_revision VALUES(1,0)',
    );
  }
  registerPlugin(manifest: PluginManifest, tools: PluginTool[]) {
    z.strictObject({
      id: z.string().regex(/^[a-z][a-z0-9-]{1,60}$/),
      name: z.string().min(1).max(100),
      description: z.string().max(1000),
      version: z.string().max(40),
      capabilities: z.array(z.string().max(300)).max(30),
    }).parse(manifest);
    if (this.plugins.has(manifest.id)) throw new ImportError('插件ID已注册。', 409);
    const names = new Set<string>();
    for (const t of tools) {
      if (
        !/^[a-z][a-z0-9_.-]{1,100}$/.test(t.name) ||
        this.definitions.has(t.name) ||
        names.has(t.name) ||
        !t.execute
      )
        throw new ImportError('插件工具重名、名称非法或缺少执行器。', 409);
      z.toJSONSchema(t.schema);
      names.add(t.name);
    }
    this.plugins.set(manifest.id, structuredClone(manifest));
    for (const t of tools) this.definitions.set(t.name, { ...t, pluginId: manifest.id });
  }
  pluginsView(actor?: Actor | null) {
    const state = this.view(actor);
    return {
      revision: state.revision,
      plugins: [...this.plugins.values()].map((p) => ({
        ...p,
        enabled: this.enabled('plugin:' + p.id),
        tools: state.tools.filter((t) => t.pluginId === p.id),
      })),
    };
  }
  setPlugin(raw: unknown, actor: Actor) {
    const v = z
      .strictObject({ id: z.string(), enabled: z.boolean(), expectedRevision: z.number().int() })
      .parse(raw);
    if (!this.plugins.has(v.id)) throw new ImportError('插件未注册。', 404);
    return this.set(
      { name: 'plugin:' + v.id, enabled: v.enabled, expectedRevision: v.expectedRevision },
      actor,
    );
  }
  private enabled(name: string) {
    return (
      this.db.prepare('SELECT enabled FROM tool_settings WHERE name=?').get(name)?.enabled !== 0
    );
  }
  private serviceReady(t: PluginTool & { pluginId: string }, actor?: Actor | null) {
    return (
      (t.pluginId !== 'order-import' || this.workflowReady()) && (t.available?.(actor) ?? true)
    );
  }
  private access(t: PluginTool, actor?: Actor | null, args?: any) {
    const local =
      t.capability === 'management' ||
      t.name.startsWith('management.') ||
      t.name.startsWith('purchase.receipt.data_edit') ||
      (t.name.startsWith('purchase.receipt.') && args?.mode === 'data-edit') ||
      t.name === 'records.delete';
    // 风险标签不另外提升权限，真实业务服务与人工接口采用相同Actor校验。
    // 声明只能增加权限，不能覆盖能力类别对应的系统最低权限。
    const required = [
      ...new Set([
        ...(t.kind === 'business' ||
        t.kind === 'workflow' ||
        t.capability === 'write' ||
        t.capability === 'management'
          ? ['business:edit']
          : []),
        ...(t.permissions || []),
      ]),
    ];
    const permissions = [...required];
    if (['order_import.execute', 'order_import.execute_many'].includes(t.name))
      permissions.push('import:execute');
    if (local) permissions.push('本机最高管理员');
    if (t.name === 'developer.execute') permissions.push('已核验的本机管理员/开发者会话');
    const permissionLimited =
      actor !== undefined &&
      !!actor &&
      (t.name === 'page.act' || t.capability === 'page') &&
      !isSuperMode(actor) &&
      !actor.permissions.includes('business:edit');
    const permissionNote =
      t.name === 'page.act' || t.capability === 'page'
        ? permissionLimited
          ? '当前账号仅可导航、滚动；写交互缺少 business:edit 权限，执行时拒绝。'
          : '导航和滚动按登录权限；写交互另需 business:edit，执行时核验。'
        : t.name === 'flow.propose_confirmation'
          ? '确认已存在的真实草稿；与人工使用相同业务服务及当前Actor权限，业务字段和库存仍逐项校验。'
          : '';
    try {
      if (actor !== undefined) {
        if (!actor) throw new ImportError('尚未登录。', 401);
        if (local && !isLocalAdministrator(actor))
          throw new ImportError('需要已核验的本机最高管理员会话。', 403);
        if (t.name === 'developer.execute') requireDeveloper(actor);
        if (
          (t.name === 'page.act' || t.capability === 'page') &&
          args &&
          !['navigate', 'scroll'].includes(args.action)
        )
          requirePermission(actor, 'business:edit');
        for (const permission of required) requirePermission(actor, permission);
        if (['order_import.execute', 'order_import.execute_many'].includes(t.name))
          requirePermission(actor, 'import:execute');
      }
      return {
        permissionLimited,
        permitted: true,
        permissions: permissions.length ? permissions : ['已登录账号'],
        permissionNote,
        permissionReason: '',
      };
    } catch (error) {
      return {
        permissionLimited,
        permitted: false,
        permissions: permissions.length ? permissions : ['已登录账号'],
        permissionNote,
        permissionReason: error instanceof Error ? error.message : '当前账号无权限',
      };
    }
  }
  view(actor?: Actor | null) {
    return {
      revision: Number(
        this.db.prepare('SELECT revision FROM tool_settings_revision WHERE id=1').get()!.revision,
      ),
      tools: [...this.definitions.values()].map(
        ({ schema, execute, available: readiness, ...t }) => {
          const pluginEnabled = this.enabled('plugin:' + t.pluginId),
            toolEnabled = this.enabled(t.name);
          const available = this.serviceReady(
            { ...t, schema, execute, available: readiness },
            actor,
          );
          const access = this.access({ ...t, schema, execute }, actor);
          const enabled = pluginEnabled && toolEnabled;
          const unavailableReasons = [
            !pluginEnabled ? '插件已停用' : '',
            !toolEnabled ? '工具已停用' : '',
            !access.permitted ? access.permissionReason : '',
            !available ? '执行服务未连接' : '',
          ].filter(Boolean);
          return {
            ...t,
            module: this.plugins.get(t.pluginId)!.name,
            parameters: z.toJSONSchema(schema),
            enabled,
            pluginEnabled,
            toolEnabled,
            available,
            ...access,
            usable: enabled && access.permitted && available,
            unavailableReasons,
            status: unavailableReasons.length
              ? unavailableReasons.join('；')
              : access.permissionLimited
                ? '部分操作可用'
                : '可用',
            serviceStatus: !available
              ? '执行服务未连接'
              : t.pluginId === 'erp-page'
                ? '页面桥接服务已接入；执行时核验当前标签页连接'
                : '已接入原业务服务',
          };
        },
      ),
    };
  }
  exposed(actor?: Actor | null) {
    return this.view(actor).tools.filter((t) => t.usable);
  }
  definition(name: string) {
    return this.definitions.get(name);
  }
  setAvailability(name: string, available: (actor?: Actor | null) => boolean) {
    const tool = this.definitions.get(name);
    if (tool) tool.available = available;
  }
  assertAvailable(name: string) {
    const t = this.definitions.get(name);
    if (!t) throw new ImportError('工具未注册。', 403);
    if (!this.enabled('plugin:' + t.pluginId)) throw new ImportError('此AI插件已停用。', 403);
    if (!this.enabled(name)) throw new ImportError('此AI工具已停用，请在AI工具管理中启用。', 403);
    if (!this.serviceReady(t)) throw new ImportError('执行服务未连接。', 503);
    return t;
  }
  set(raw: unknown, actor: Actor) {
    requirePermission(actor, 'business:edit');
    if (actor.role !== 'super_admin') throw new ImportError('仅超级管理员可管理AI工具启停。', 403);
    const v = z
      .strictObject({ name: z.string(), enabled: z.boolean(), expectedRevision: z.number().int() })
      .parse(raw);
    if (
      !this.definitions.has(v.name) &&
      !(v.name.startsWith('plugin:') && this.plugins.has(v.name.slice(7)))
    )
      throw new ImportError('工具未注册。', 404);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.view().revision !== v.expectedRevision)
        throw new ImportError('工具设置已更新，请刷新。', 409);
      this.db
        .prepare(
          'INSERT INTO tool_settings VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at',
        )
        .run(v.name, v.enabled ? 1 : 0, new Date().toISOString());
      this.db.exec('UPDATE tool_settings_revision SET revision=revision+1 WHERE id=1; COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.view();
  }
  async dispatch(
    name: string,
    args: unknown,
    actor: Actor,
    handlers: Record<ToolKind, (name: string, args: any) => unknown>,
    context?: unknown,
  ) {
    if (!actor) throw new ImportError('请先登录。', 401);
    const t = this.assertAvailable(name),
      parsed = t.schema.parse(args);
    const supplied = context as
      | { check?: () => Actor; signal?: AbortSignal; reuseResult?: unknown; onExecute?: () => void }
      | undefined;
    const check = () => {
      const live = supplied?.check ? supplied.check() : actor;
      if (!live || live.id !== actor.id || supplied?.signal?.aborted)
        throw new ImportError('真实登录身份已变化或执行已停止。', 403);
      this.assertAvailable(name);
      const access = this.access(t, live, parsed);
      if (!access.permitted) throw new ImportError(access.permissionReason, 403, 'permission');
      return live;
    };
    const current = check();
    if (!(supplied && Object.hasOwn(supplied, 'reuseResult')) && t.execute)
      (supplied as any)?.onExecute?.();
    const value =
      supplied && Object.hasOwn(supplied, 'reuseResult')
        ? supplied.reuseResult
        : t.execute
          ? await t.execute(parsed, current, { ...(context as any), check })
          : await handlers[t.kind](name, parsed);
    check();
    return { kind: t.kind, value };
  }

  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}

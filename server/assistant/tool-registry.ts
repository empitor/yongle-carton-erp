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
import { requirePermission } from '../business/management.js';
import { developerCommandSchema } from '../../shared/developer.js';
import { requireDeveloper } from '../developer-capability.js';

const positive = z.number().int().positive(),
  uuid = z.string().uuid();
const task = { taskId: uuid.optional() },
  module = z.enum(assistantModules);
const schemas: Record<string, z.ZodType> = {
  'developer.execute': developerCommandSchema,
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
    filters: z.record(z.string(), z.unknown()).optional(),
    limit: z.number().int().min(1).max(20).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  'records.summarize': z.strictObject({
    module,
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
  'order_import.start': z.strictObject({
    attachmentIds: z.array(uuid).max(6).optional(),
    recognitionType: z.enum(['order', 'arrival']),
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
  private readonly definitions = new Map(
    toolCatalog.map((t) => {
      if (!schemas[t.name]) throw new Error('工具缺少参数结构：' + t.name);
      return [
        t.name,
        {
          ...t,
          kind: (t.risk === 'workflow'
            ? 'workflow'
            : t.risk === 'read'
              ? 'read'
              : 'business') as ToolKind,
          schema: schemas[t.name],
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
  private enabled(name: string) {
    return (
      this.db.prepare('SELECT enabled FROM tool_settings WHERE name=?').get(name)?.enabled !== 0
    );
  }
  view() {
    return {
      revision: Number(
        this.db.prepare('SELECT revision FROM tool_settings_revision WHERE id=1').get()!.revision,
      ),
      tools: [...this.definitions.values()].map(({ schema, ...t }) => ({
        ...t,
        module:
          t.kind === 'workflow'
            ? '单据识别与导入'
            : t.name === 'attachments.read'
              ? '附件阅读'
              : t.name === 'ui.open'
                ? '页面导航'
                : t.name === 'overview.get'
                  ? '经营概览'
                  : t.name.startsWith('records.')
                    ? '业务档案与单据'
                    : '库存与实物流转',
        parameters: z.toJSONSchema(schema),
        enabled: this.enabled(t.name),
        available: t.kind !== 'workflow' || this.workflowReady(),
        status: t.kind === 'workflow' && !this.workflowReady() ? '服务未连接' : '已接入原业务服务',
      })),
    };
  }
  exposed() {
    return this.view().tools.filter((t) => t.enabled && t.available);
  }
  assertAvailable(name: string) {
    const t = this.definitions.get(name);
    if (!t) throw new ImportError('工具未注册。', 403);
    if (!this.enabled(name)) throw new ImportError('此AI工具已停用，请在AI工具管理中启用。', 403);
    if (t.kind === 'workflow' && !this.workflowReady())
      throw new ImportError('识别业务服务未连接。', 503);
    return t;
  }
  set(raw: unknown, actor: Actor) {
    requirePermission(actor, 'business:edit');
    if (actor.role !== 'super_admin') throw new ImportError('仅超级管理员可管理AI工具启停。', 403);
    const v = z
      .strictObject({ name: z.string(), enabled: z.boolean(), expectedRevision: z.number().int() })
      .parse(raw);
    if (!this.definitions.has(v.name)) throw new ImportError('工具未注册。', 404);
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
  ) {
    if (!actor) throw new ImportError('请先登录。', 401);
    const t = this.assertAvailable(name);
    if (name === 'developer.execute') requireDeveloper(actor);
    const parsed = t.schema.parse(args);
    return { kind: t.kind, value: await handlers[t.kind](name, parsed) };
  }
  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}

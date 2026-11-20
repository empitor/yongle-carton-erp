import { builtinPlugins, builtinPluginFor, type PluginTool } from './plugins.js';
import type { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { defaultDbPath, one, openVersionedSqlite, registerVersionedSqlite, rows } from '../core/index.js';
import { AppError, canEnterSuperMode, isLocalAdministrator, requirePermission, requireSuperModeFor, type Actor } from '../core/index.js';
import { financeOnlyAccount, financeOnlyToolAllowed, type Permission } from '../../shared/core/index.js';
import { toolDefinitions } from './tool-catalog.js';
import { localOnlyMessage } from './plan-rules.js';
import { AssistantAccountSettings } from './account-settings.js';
import { AssistantMemory } from './memory-store.js';
import { asJson } from './json-view.js';
import { pluginSettingBody, toolParametersSchema, toolSettingBody, type PluginsView, type ToolsView } from '../../shared/assistant/index.js';
import { memoryExecutors } from './tools/memory.js';

export const defaultAssistantToolsPath = () =>
  join(dirname(defaultDbPath), 'ai-tools', 'tools.sqlite');
/**
 * 助手工具设置库（ai-tools/tools.sqlite）：工具和插件的启停；第 2 版起还放按账号的助手设置（account-settings.ts）
 * 和长期记忆（memory-store.ts），不进业务库，业务数据初始化不会清掉它们。旧版本的库打开时删掉重建（server/core/versioned-sqlite.ts）。
 */
const toolSettingsDatabase = {
  label: '助手工具设置库',
  latest: 2,
  pragmas: 'PRAGMA synchronous=FULL',
  create(db: DatabaseSync) {
    db.exec(`CREATE TABLE tool_settings(name TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE tool_settings_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);`);
    // 按账号的助手设置（account-settings.ts）和长期记忆（memory-store.ts），每行都带 user_id
    db.exec(`CREATE TABLE assistant_account_settings(
        user_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, name)
      ) STRICT;
      CREATE TABLE assistant_memories(
        id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, content TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('assistant','manual')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX assistant_memories_user ON assistant_memories(user_id, updated_at);`);
  },
};
// 默认位置登记进配置库登记表：恢复备份的维护命令行不打开这个库，靠这一条认出备份里的 ai-tools/tools.sqlite、支持到第几版
registerVersionedSqlite(toolSettingsDatabase, defaultAssistantToolsPath);
export type ToolKind = 'read' | 'business' | 'workflow';
/** 按类别执行工具的函数（对话层给的）：参数已经按工具的结构校验过 */
export type ToolHandlers = Record<ToolKind, (name: string, args: unknown) => unknown>;
/** 分派时对话层给的：现在登录的是谁（中途换人、改权限就停）、这一轮的中止信号 */
type DispatchContext = { check?: () => Actor; signal?: AbortSignal };
/** 插件整组启停在设置表里的名字前缀 */
const PLUGIN_PREFIX = 'plugin:';
/** 本机专用的工具（名字前缀） */
const isLocalTool = (name: string) => name.startsWith('management.') || name.startsWith('system.');
type RegisteredTool = PluginTool & { pluginId: string };
/** 正式导入订单：除了编辑权限还要导入权限 */
const IMPORT_TOOL = 'order_import.execute';
// 清空预览（management.reset_preview）不在里面：一键清空的服务自己要求本机最高管理员
const superAdminReads = new Set(['system.status', 'system.check', 'management.context', 'management.delete_preview']);
/**
 * 只给超级管理员账号的工具（不要求进超级管理员模式）：读账号、设置、运行日志、登录记录、程序代码，和改全员共用的提示词。
 * 执行时各自也查一次（tools/admin-view.ts、server/core/diagnostics/、prompt-edit.ts）；这里让清单显示和执行一致，
 * 别的账号的助手清单里也就没有它们。新加这类工具时补在这里。
 */
export const superAdminTools = new Set([
  'accounts.list',
  'settings.view',
  'accounts.events',
  'logs.read',
  'source.search',
  'source.read',
  'prompts.propose',
  // 更正完工单要超级管理员模式（和撤销这次完工同一级），别的账号看不到
  'production.correct',
]);
const kindOf = (risk: string): ToolKind => (risk === 'workflow' ? 'workflow' : risk === 'read' ? 'read' : 'business');

/**
 * 工具要的权限：required 是真要核对的（业务类、流程类一律要编辑权限，工具自己声明的只能再加、不能减）；
 * permissions 是给页面列的说明（另加导入权限、本机专用的说明）。风险标签不另外提升权限，真实业务服务与人工接口采用相同Actor校验。
 */
function toolPermissions(t: PluginTool) {
  const local = isLocalTool(t.name);
  const edit: Permission[] = t.kind === 'business' || t.kind === 'workflow' ? ['business:edit'] : [];
  const required = [...new Set([...edit, ...(t.permissions || [])])];
  const permissions: string[] = [...required];
  if (t.name === IMPORT_TOOL) permissions.push('import:execute');
  // 本机专用里只读的那几个，从域名访问的超级管理员账号也能用（用户 2026-11-13 定）；写入的仍只限本机
  if (local) permissions.push(superAdminReads.has(t.name) ? '本机最高管理员或超级管理员' : '本机最高管理员');
  return { required, permissions };
}

/** 这个账号能不能用这个工具：不能就抛出说明原因的 AppError */
function checkAccess(t: PluginTool, actor: Actor | null, required: Permission[]) {
  const local = isLocalTool(t.name);
  const superAdminRead = local && superAdminReads.has(t.name);
  if (!actor) throw new AppError('尚未登录。', 401);
  // 出纳这类纯财务账号只看财务，读业务数据的工具也不能用。
  if (financeOnlyAccount(actor) && !financeOnlyToolAllowed(t.name))
    throw new AppError('出纳账号只能查看财务数据。', 403);
  if (superAdminTools.has(t.name) && !canEnterSuperMode(actor))
    throw new AppError('只有超级管理员账号能用这个工具。', 403, 'permission');
  if (local && !isLocalAdministrator(actor) && !(superAdminRead && canEnterSuperMode(actor)))
    // 不是本机最高管理员会话（从域名进来，或本机的普通账号）：说清只能在服务器本机做、到哪里做
    throw new AppError(localOnlyMessage(t.name), 403);
  for (const permission of required) requirePermission(actor, permission);
  if (t.name === IMPORT_TOOL) requirePermission(actor, 'import:execute');
}

/** 注册定义、持久启停与调度共用同一目录；业务规则仍由原服务验证。 */
export class AssistantToolRegistry {
  readonly db: DatabaseSync;
  /** 按账号的助手设置（自动记忆开关等），和工具设置同一个库。 */
  readonly accountSettings: AssistantAccountSettings;
  /** 长期记忆，按账号分开；记忆工具的执行函数在构造时接上。 */
  readonly memory: AssistantMemory;
  private closed = false;
  private readonly plugins = new Map(builtinPlugins.map((p) => [p.id, p]));
  private readonly definitions = new Map<string, RegisteredTool>(
    toolDefinitions.map(({ schema, ...t }) => [
      t.name,
      {
        ...t,
        ...(t.name.startsWith('prompts.') ? { permissions: ['business:edit'] } : {}),
        ...(t.name.startsWith('finance.') ? { permissions: ['finance:view'] } : {}),
        pluginId: builtinPluginFor(t.name),
        kind: kindOf(t.risk),
        schema,
      },
    ]),
  );
  constructor(
    file = ':memory:',
    private workflowReady = () => false,
  ) {
    this.db = openVersionedSqlite(file, toolSettingsDatabase);
    this.db.exec('INSERT OR IGNORE INTO tool_settings_revision(id,revision) VALUES(1,0)');
    this.accountSettings = new AssistantAccountSettings(this.db);
    this.memory = new AssistantMemory(this.db, this.accountSettings);
    // 只读的查记忆由注册表直接执行；记、改、忘、开关自动记忆由对话层直接执行（chat/workflow-direct.ts）
    for (const [name, execute] of Object.entries(memoryExecutors(this.memory))) {
      const definition = this.definitions.get(name);
      if (!definition) throw new Error('长期记忆的执行函数没有对应的工具：' + name);
      if (definition.kind === 'read') definition.execute = execute;
    }
  }
  pluginsView(actor?: Actor | null): PluginsView {
    const state = this.view(actor);
    return {
      revision: state.revision,
      plugins: [...this.plugins.values()].map((p) => ({
        ...p,
        enabled: this.enabled(PLUGIN_PREFIX + p.id),
        tools: state.tools.filter((t) => t.pluginId === p.id),
      })),
    };
  }
  setPlugin(raw: unknown, actor: Actor) {
    const v = pluginSettingBody.parse(raw);
    if (!this.plugins.has(v.id)) throw new AppError('插件未注册。', 404);
    return this.set(
      { name: PLUGIN_PREFIX + v.id, enabled: v.enabled, expectedRevision: v.expectedRevision },
      actor,
    );
  }
  private enabled(name: string) {
    return one(this.db, rows.tool_settings.pick({ enabled: true }), 'SELECT enabled FROM tool_settings WHERE name=?', name)?.enabled !== 0;
  }
  private serviceReady(t: RegisteredTool, actor?: Actor | null) {
    return (
      (t.pluginId !== 'order-import' || this.workflowReady()) && (t.available?.(actor) ?? true)
    );
  }
  private access(t: PluginTool, actor?: Actor | null) {
    const { required, permissions } = toolPermissions(t);
    const permissionNote =
      t.name === 'flow.propose_confirmation'
          ? '核对已登记的真实单据（待入库、待送货）；与人工使用相同业务服务及当前Actor权限，业务字段和库存仍逐项校验。'
          : '';
    const shown = permissions.length ? permissions : ['已登录账号'];
    try {
      if (actor !== undefined) checkAccess(t, actor, required);
      return { permitted: true, permissions: shown, permissionNote, permissionReason: '' };
    } catch (error) {
      return {
        permitted: false,
        permissions: shown,
        permissionNote,
        permissionReason: error instanceof Error ? error.message : '当前账号无权限',
      };
    }
  }
  view(actor?: Actor | null): ToolsView {
    return {
      revision: this.revision(),
      tools: [...this.definitions.values()].map(
        ({ schema, execute, available: readiness, ...t }) => {
          const pluginEnabled = this.enabled(PLUGIN_PREFIX + t.pluginId),
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
            module: this.pluginName(t.pluginId),
            arguments: asJson(t.arguments),
            parameters: toolParametersSchema.parse(asJson(z.toJSONSchema(schema))),
            enabled,
            pluginEnabled,
            toolEnabled,
            available,
            ...access,
            usable: enabled && access.permitted && available,
            unavailableReasons,
            status: unavailableReasons.length
              ? unavailableReasons.join('；')
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
  assertAvailable(name: string) {
    const t = this.definitions.get(name);
    if (!t) throw new AppError('工具未注册。', 403, 'unknown-tool');
    if (!this.enabled(PLUGIN_PREFIX + t.pluginId)) throw new AppError('此AI插件已停用。', 403, 'tool-disabled');
    if (!this.enabled(name))
      throw new AppError('此AI工具已停用，请在AI工具管理中启用。', 403, 'tool-disabled');
    if (!this.serviceReady(t))
      throw new AppError('执行服务未连接。', 503);
    return t;
  }
  set(raw: unknown, actor: Actor) {
    // 工具启停管所有人的助手：和其它共用设置一样要先进超级管理员模式
    requireSuperModeFor(actor, '启停助手工具');
    const v = toolSettingBody.parse(raw);
    if (
      !this.definitions.has(v.name) &&
      !(v.name.startsWith(PLUGIN_PREFIX) && this.plugins.has(v.name.slice(PLUGIN_PREFIX.length)))
    )
      throw new AppError('工具未注册。', 404);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.view().revision !== v.expectedRevision)
        throw new AppError('工具设置已更新，请刷新。', 409);
      this.db
        .prepare(
          'INSERT INTO tool_settings(name,enabled,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at',
        )
        .run(v.name, v.enabled ? 1 : 0, new Date().toISOString());
      this.db.exec('UPDATE tool_settings_revision SET revision=revision+1 WHERE id=1; COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.view();
  }
  async dispatch(name: string, args: unknown, actor: Actor, handlers: ToolHandlers, context?: DispatchContext) {
    if (!actor) throw new AppError('请先登录。', 401);
    const t = this.assertAvailable(name),
      parsed: unknown = t.schema.parse(args);
    const supplied = context;
    const check = () => {
      const live = supplied?.check ? supplied.check() : actor;
      if (!live || live.id !== actor.id || supplied?.signal?.aborted)
        throw new AppError('真实登录身份已变化或执行已停止。', 403);
      this.assertAvailable(name);
      const access = this.access(t, live);
      if (!access.permitted) throw new AppError(access.permissionReason, 403, 'permission');
      return live;
    };
    const current = check();
    const value = t.execute
      ? await t.execute(parsed, current, { ...context, check })
      : await handlers[t.kind](name, parsed);
    check();
    return { kind: t.kind, value };
  }

  private revision() {
    const row = one(this.db, rows.tool_settings_revision.pick({ revision: true }), 'SELECT revision FROM tool_settings_revision WHERE id=1');
    if (!row) throw new Error('工具设置库缺少修订号这一行');
    return row.revision;
  }
  private pluginName(id: string) {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error('工具归属的插件没有登记：' + id);
    return plugin.name;
  }
  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}

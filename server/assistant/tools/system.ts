// 系统维护的助手工具：查看系统状态（含运行多久、磁盘）、数据库体检、一键清空的影响预览、马上做一次完整备份（只读的三个和备份的执行）。
import { existsSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Store } from '../../core/index.js';
import type { Actor } from '../../core/index.js';
import { AppError, count as countRows, currentSchemaVersion, many, readBackupManifest, resetCounts, resetParticipants } from '../../core/index.js';
import { toolSpec } from './define.js';
import { audit } from '../../core/index.js';
import { BusinessReset } from '../../admin/index.js';
import { negativeStock } from '../../operations/index.js';
import { unassignedProducts } from '../../sales/index.js';
import { businessResetScope } from '../../../shared/admin/index.js';
import { createFullBackup } from '../../core/index.js';
import { APP_VERSION, MIB, UNITS_PER_QUANTITY } from '../../../shared/core/index.js';

const resetPreviewSchema = z.strictObject({ scope: z.enum(businessResetScope) });
// 执行在 extra-tools.ts（AssistantExtraTools 的 read、call）
export const systemTools = [
  toolSpec({
    name: 'system.status',
    description: '查系统状态：版本、运行时长、数据库大小、剩余磁盘、主要记录数、最近备份；备份失败看 jobs.status。',
    risk: 'read',
    schema: z.strictObject({}),
  }),
  toolSpec({
    name: 'system.check',
    description: '数据库体检：完整性、断开的关联、负库存、还没定所属客户的产品。只读。',
    risk: 'read',
    schema: z.strictObject({}),
  }),
  toolSpec({
    name: 'system.backup',
    description:
      '马上做一次完整备份，和每日自动备份内容一样，用户要求才做。恢复备份助手做不了，告诉用户停机后运行 npm run restore。',
    risk: 'workflow',
    schema: z.strictObject({}),
  }),
  toolSpec({
    name: 'management.reset_preview',
    description: '查一键清空会删多少条数据，不删东西；清空前先用它把数量告诉用户。',
    risk: 'read',
    schema: resetPreviewSchema,
  }),
];

const GIGABYTE = 1e9;
const SECONDS_PER_MINUTE = 60;
/** 最近的备份、完整性检查的结果最多列几条 */
const SHOW_MAX = 5;
/** 保留一位小数 */
const TENTHS = 10;
const oneDecimal = (n: number) => Math.round(n * TENTHS) / TENTHS;
const megabytes = (bytes: number) => oneDecimal(bytes / MIB);

export type BackupSettings = {
  dataDir: string;
  backupRoot: string;
  extraFiles?: Record<string, string>;
};
/** 这些工具要用的东西，AssistantExtraTools（extra-tools.ts）满足它；backingUp 是“正在备份”的标记，由 systemBackup 改写。 */
export type SystemDeps = {
  store: Store;
  backup: BackupSettings;
  imports: { status(): { workspaces: unknown[] } };
  backingUp: boolean;
};
/** management.reset_preview：args 是注册表按定义校验过的，这里按同一份结构取类型 */
export function resetPreview(tools: SystemDeps, args: unknown, actor: Actor) {
  const v = resetPreviewSchema.parse(args);
  const reset = new BusinessReset(tools.store);
  const preview = reset.preview(v.scope, actor);
  const total = Object.values(preview.tables).reduce((a, b) => a + b, 0);
  const financeRows = v.scope === 'ai-imports' ? 0 : reset.financeRows();
  return {
    scope: v.scope,
    total,
    ...(financeRows
      ? {
          financeRows,
          blocked:
            '财务里已有记录，助手不能执行这次清空，要到“系统维护”页面操作，那里会连财务一起清。',
        }
      : {}),
    nonEmpty: Object.fromEntries(
      Object.entries(preview.tables).filter(([, n]) => n > 0),
    ),
    closedFinancePeriods: preview.finance?.closed?.length || 0,
    workspaces: v.scope === 'business' ? undefined : tools.imports.status().workspaces.length,
    message: '这只是预览，什么都没删。',
  };
}
/** 系统状态列的主要记录（业务表），和这些表的主人模块 */
const RECORD_TABLES = ['customers', 'products', 'orders', 'suppliers', 'purchases', 'stock_movements', 'inbox_items', 'product_marks'];
const RECORD_MODULES = ['基础', '采购库存', '识别导入', '客户产品订单'] as const;
/**
 * 主要记录数：业务表由各模块按自己登记的清空语句数（core 的 resetCounts，和一键清空预览同一个数法），
 * 助手不直接数别的模块的表；会话数是助手自己的表。
 */
function recordCounts(store: Store): Record<string, number> {
  const counted = new Map(resetParticipants(RECORD_MODULES, false).flatMap((r) => Object.entries(resetCounts(store, r))));
  const unregistered = (table: string): never => {
    throw new Error('没有模块登记清空规则的表：' + table);
  };
  const countOf = (table: string) => counted.get(table) ?? unregistered(table);
  return {
    ...Object.fromEntries(RECORD_TABLES.map((t) => [t, countOf(t)])),
    assistant_threads: countRows(store.db, 'SELECT COUNT(*) AS n FROM assistant_threads'),
  };
}
function backups(tools: SystemDeps) {
  const root = tools.backup.backupRoot;
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^(?:auto|full)-/.test(e.name) && !e.name.endsWith('.partial'))
    .map((e) => {
      const dir = join(root, e.name);
      let bytes: number | null = null;
      try {
        bytes = readBackupManifest(dir).files.reduce((n, f) => n + f.bytes, 0);
      } catch {
        /* 清单读不了也要列出来，体积留空 */
      }
      return {
        name: e.name,
        kind: e.name.startsWith('auto-') ? '每日自动' : '手动',
        at: statSync(dir).mtime.toISOString(),
        megabytes: bytes === null ? null : megabytes(bytes),
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}
/** 业务库所在磁盘的剩余和总量（GB）；内存库或读不到时 null */
function diskOf(path: string) {
  if (path === ':memory:') return null;
  try {
    const s = statfsSync(dirname(path)),
      gb = (blocks: number) => oneDecimal((blocks * s.bsize) / GIGABYTE);
    return { freeGigabytes: gb(s.bavail), totalGigabytes: gb(s.blocks) };
  } catch {
    return null;
  }
}
/** system.status */
export function systemStatus(tools: SystemDeps) {
  const db = tools.store.db;
  const list = backups(tools);
  return {
    version: APP_VERSION,
    uptimeMinutes: Math.round(process.uptime() / SECONDS_PER_MINUTE),
    disk: diskOf(tools.store.path),
    databaseMegabytes:
      tools.store.path === ':memory:' || !existsSync(tools.store.path)
        ? null
        : megabytes(statSync(tools.store.path).size),
    schemaVersion: currentSchemaVersion(db),
    records: recordCounts(tools.store),
    backups: { total: list.length, latest: list.slice(0, SHOW_MAX) },
  };
}
const integrityRow = z.object({ integrity_check: z.string() });
/** 负库存和没定客户的产品最多各列几个 */
const NEGATIVE_SHOWN = 20;
const UNASSIGNED_SHOWN = 20;
function unassignedNote(item: { name: string; orderedCustomers: string[] }) {
  if (item.orderedCustomers.length > 1) return item.name + '（给 ' + item.orderedCustomers.join('、') + ' 下过单）';
  if (item.orderedCustomers.length === 1) return item.name + '（给 ' + item.orderedCustomers[0] + ' 下过单）';
  return item.name + '（没下过单）';
}
/** system.check */
export function systemCheck(tools: SystemDeps) {
  const db = tools.store.db;
  const integrity = many(db, integrityRow, 'PRAGMA integrity_check').map((r) => r.integrity_check);
  const brokenLinks = countRows(db, 'SELECT COUNT(*) FROM pragma_foreign_key_check');
  const negative = negativeStock(tools.store, NEGATIVE_SHOWN);
  const unassigned = unassignedProducts(tools.store, UNASSIGNED_SHOWN);
  const problems = [
    ...(integrity.length === 1 && integrity[0] === 'ok' ? [] : ['数据库完整性检查没通过']),
    ...(brokenLinks ? [brokenLinks + ' 处关联断开'] : []),
    ...negative.map((n) => n.name + ' 库存为负：' + n.units / UNITS_PER_QUANTITY + ' ' + n.unit),
  ];
  const baseMessage = problems.length ? '发现 ' + problems.length + ' 个问题。' : '数据库正常，没有发现问题。';
  return {
    healthy: !problems.length,
    integrity: integrity.slice(0, SHOW_MAX),
    brokenLinks,
    negativeStock: negative.length,
    unassignedProducts: {
      total: unassigned.total,
      items: unassigned.shown.map((item) => ({ ...item, summary: unassignedNote(item) })),
    },
    problems,
    message: unassigned.total
      ? baseMessage + ' 另有 ' + unassigned.total + ' 个产品还没定所属客户，可在产品页确认。'
      : baseMessage,
  };
}
/** system.backup */
export async function systemBackup(tools: SystemDeps, ctx: { check: () => Actor }) {
  const actor = ctx.check();
  if (tools.backingUp) throw new AppError('已经有一个备份在进行中。', 409);
  tools.backingUp = true;
  try {
    const result = await createFullBackup({ ...tools.backup, prefix: 'full' });
    audit(tools.store, actor, {
      action: 'full-backup',
      entity: 'system',
      id: null,
      document: { files: result.files, bytes: result.bytes },
    });
    return {
      name: result.dir.split(/[\\/]/).pop(),
      files: result.files,
      megabytes: megabytes(result.bytes),
      verified: true,
      message: '完整备份已生成，共 ' + result.files + ' 个文件。',
    };
  } finally {
    tools.backingUp = false;
  }
}

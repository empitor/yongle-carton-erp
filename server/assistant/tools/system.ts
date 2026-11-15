// 系统维护的助手工具：查看系统状态（含运行多久、磁盘）、数据库体检、一键清空的影响预览、马上做一次完整备份（只读的三个和备份的执行）。
import { existsSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Store } from '../../core/index.js';
import type { Actor } from '../../core/index.js';
import { AppError, count as countRows, many, one, readBackupManifest, rows } from '../../core/index.js';
import { audit } from '../../core/index.js';
import { BusinessReset } from '../../admin/index.js';
import { businessResetScope } from '../../../shared/admin/index.js';
import { createFullBackup } from '../../core/index.js';
import { APP_VERSION, MIB, UNITS_PER_QUANTITY } from '../../../shared/core/index.js';

export const systemTools = [
  {
    name: 'system.status',
    description:
      '查系统状态：版本、运行时长、数据库大小、剩余磁盘、主要记录数、最近备份；备份失败看 jobs.status。',
    arguments: {},
    risk: 'read',
    schema: z.strictObject({}),
  },
  {
    name: 'system.check',
    description:
      '数据库体检：完整性、断开的关联、负库存。只读。',
    arguments: {},
    risk: 'read',
    schema: z.strictObject({}),
  },
  {
    name: 'system.backup',
    description:
      '马上做一次完整备份，和每日自动备份内容一样，用户要求才做。恢复备份助手做不了，告诉用户停机后运行 npm run restore。',
    arguments: {},
    risk: 'workflow',
    schema: z.strictObject({}),
  },
  {
    name: 'management.reset_preview',
    description:
      '查一键清空会删多少条数据，不删东西；清空前先用它把数量告诉用户。',
    arguments: { scope: ['business', 'ai-imports', 'all'] },
    risk: 'read',
    schema: z.strictObject({ scope: z.enum(['business', 'ai-imports', 'all']) }),
  },
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
  backup?: BackupSettings;
  imports?: { status(): { workspaces: unknown[] } };
  backingUp: boolean;
};
/** management.reset_preview */
export function resetPreview(tools: SystemDeps, raw: unknown, actor: Actor) {
  const v = z.strictObject({ scope: z.enum(businessResetScope) }).parse(raw);
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
    workspaces: v.scope === 'business' ? undefined : tools.imports?.status().workspaces.length,
    message: '这只是预览，什么都没删。',
  };
}
function count(tools: SystemDeps, table: string) {
  try {
    return countRows(tools.store.db, `SELECT COUNT(*) AS n FROM "${table}"`);
  } catch {
    return null;
  }
}
function backups(tools: SystemDeps) {
  const root = tools.backup?.backupRoot;
  if (!root || !existsSync(root)) return [];
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
const schemaVersionRow = z.object({ version: rows.schema_migrations.shape.version.nullable() });
/** system.status */
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
    schemaVersion: one(db, schemaVersionRow, 'SELECT MAX(version) AS version FROM schema_migrations')?.version ?? 0,
    records: Object.fromEntries(
      ['customers', 'products', 'orders', 'suppliers', 'purchases', 'stock_movements', 'inbox_items', 'product_marks', 'assistant_threads'].map(
        (t) => [t, count(tools, t)],
      ),
    ),
    backups: { total: list.length, latest: list.slice(0, SHOW_MAX), configured: !!tools.backup },
  };
}
const integrityRow = z.object({ integrity_check: z.string() });
const negativeRow = rows.stock_items.pick({ name: true, unit: true }).extend({ units: z.number() });
/** system.check */
export function systemCheck(tools: SystemDeps) {
  const db = tools.store.db;
  const integrity = many(db, integrityRow, 'PRAGMA integrity_check').map((r) => r.integrity_check);
  const brokenLinks = countRows(db, 'SELECT COUNT(*) FROM pragma_foreign_key_check');
  const negative = many(
    db,
    negativeRow,
    'SELECT i.name,i.unit,SUM(m.delta_units) AS units FROM stock_movements m JOIN stock_items i ON i.id=m.item_id GROUP BY m.item_id HAVING SUM(m.delta_units)<0 LIMIT 20',
  );
  const problems = [
    ...(integrity.length === 1 && integrity[0] === 'ok' ? [] : ['数据库完整性检查没通过']),
    ...(brokenLinks ? [brokenLinks + ' 处关联断开'] : []),
    ...negative.map((n) => n.name + ' 库存为负：' + n.units / UNITS_PER_QUANTITY + ' ' + n.unit),
  ];
  return {
    healthy: !problems.length,
    integrity: integrity.slice(0, SHOW_MAX),
    brokenLinks,
    negativeStock: negative.length,
    problems,
    message: problems.length ? '发现 ' + problems.length + ' 个问题。' : '数据库正常，没有发现问题。',
  };
}
/** system.backup */
export async function systemBackup(tools: SystemDeps, ctx: { check: () => Actor }) {
  const actor = ctx.check();
  if (!tools.backup) throw new AppError('这个实例没有配置备份目录。', 503);
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

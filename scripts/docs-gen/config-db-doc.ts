// 表结构文档的配置库部分：登记过的配置库规格（取法和导出基线快照同一份，scripts/config-db-dump.ts 的 configDatabases）
// 逐个在内存里建一遍，记下 create 执行的建表语句（连同前面的注释），写成文档。规格写在哪个文件、归哪个模块从代码里找。
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { one, openVersionedSqlite } from '../../server/core/index.js';
import { all, moduleOf } from '../../tests/checks/module-map.js';
import { configDatabases } from '../config-db-dump.js';
import { code } from './markdown.js';
import { sqlParts } from './sql-parts.js';
import { sourceLines } from './table-doc.js';

type Spec = ReturnType<typeof configDatabases>[number]['spec'];
/** 登记过的配置库规格：没登记短名的，configDatabases 直接报错 */
const specs = () => configDatabases().map((database) => database.spec);

/** 配置库这一节开头的说明 */
const CONFIG_INTRO = [
  '## 配置库',
  '',
  '配置库各是一个 SQLite 文件，用自己的 `PRAGMA user_version` 记版本：基线是 0.9.0 发布时的版本，当前版本是基线加升级步骤数。版本怎么算、规格怎么写、怎么升级，相关的见 `docs/架构/数据库升级.md`。',
  '',
  '- **配置目录：** 配置目录在哪，相关的见 `docs/运维/部署.md`；“数据目录”是业务库所在的目录。',
  '- **业务初始化：** 只按范围清识别工作区，别的配置库不动。',
  '- **快照和备份：** 业务库快照、配置库升级前备份放在哪，相关的见 `docs/运维/备份恢复.md`。',
  '',
];

/** 规格写在哪个文件：server/ 下写着这个中文名（label: '…'）的那一份，要正好一份。server/ 的文件只读一遍 */
function specFiles(specs: Spec[]) {
  const markers = specs.map((spec) => `label: '${spec.label}'`);
  const found = new Map<string, string[]>(markers.map((marker) => [marker, []]));
  for (const file of all.filter((name) => name.startsWith('server/'))) {
    const text = readFileSync(file, 'utf8');
    for (const marker of markers) if (text.includes(marker)) found.get(marker)?.push(file);
  }
  return specs.map((spec, i) => {
    const files = found.get(markers[i]) ?? [];
    if (files.length !== 1)
      throw new Error(`配置库“${spec.label}”的规格要正好写在 server/ 的一个文件里（找 ${markers[i]}），找到 ${files.length} 个`);
    return { spec, file: files[0] };
  });
}

const versionRow = z.object({ user_version: z.number() });
/** 按程序打开一个空库读出来的版本（就是当前版本） */
function currentVersion(spec: Spec) {
  const db = openVersionedSqlite(':memory:', spec);
  try {
    return one(db, versionRow, 'PRAGMA user_version')?.user_version ?? 0;
  } finally {
    db.close();
  }
}

/** 在内存里跑一遍 create，记下它执行的 SQL（库留着核对列用） */
function recordCreate(spec: Spec) {
  const db = new DatabaseSync(':memory:');
  const statements: string[] = [];
  const exec = db.exec.bind(db);
  db.exec = (sql: string) => {
    statements.push(sql);
    exec(sql);
  };
  spec.create(db);
  return { db, sql: statements.join(';\n') };
}

function databaseLines(spec: Spec, file: string, tableNames: ReadonlySet<string>) {
  const { db, sql } = recordCreate(spec);
  try {
    const owner = moduleOf(file)?.name ?? '没登记模块';
    return [
      '### ' + spec.label,
      '',
      `- 规格和建表：${code(file)}；主人：${owner}`,
      `- 版本：第 ${currentVersion(spec)} 版（基线第 ${spec.baseline} 版，升级步骤 ${spec.steps.length} 步）`,
      '',
      ...sourceLines({ parts: sqlParts(sql), db, tableNames }, spec.label),
    ];
  } finally {
    db.close();
  }
}

/** 配置库里全部的表名（说明里认表名用） */
export function configTableNames() {
  return specs().flatMap((spec) => {
    const { db, sql } = recordCreate(spec);
    db.close();
    return sqlParts(sql).flatMap((part) => (part.kind === 'table' ? [part.name] : []));
  });
}

/** 配置库一节的全文行：按规格文件的路径排，和加载先后无关 */
export function configDatabaseLines(tableNames: ReadonlySet<string>) {
  const sorted = specFiles(specs()).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return [...CONFIG_INTRO, ...sorted.flatMap(({ spec, file }) => databaseLines(spec, file, tableNames))];
}

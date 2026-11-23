// 把每个配置库基线版本的结构导出成可以直接执行的 SQL：tests/fixtures/config-db/<短名>-v<基线>.sql。
// 由 npm run schema:dump 一起生成（scripts/schema-dump.ts 调这里），守它的测试在 tests/core/config-db-evolution.test.ts。
//
// - 只在内存里按各库主人模块登记的规格（registerVersionedSqlite）建空库，不碰任何数据文件。
// - 还没有升级步骤的库才导出：这时 create 建出来的就是基线结构。有了步骤以后基线快照定下不改，这里不再碰它。
// - 输出是确定的：建立语句按 sqlite_schema 里的先后（建库时的先后），最后记上基线版本；换行一律 LF。
// - 短名（configDbKeys）是基线快照和升级样例（tests/fixtures/upgrade-samples/<短名>/）的文件名，只在这里定义；新加配置库在这里登记。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { openVersionedSqlite, registeredVersionedSqlite } from '../server/core/index.js';
// 这几个模块加载时登记各自的配置库规格（出错记录库随 core 一起登记）
import '../server/accounts/index.js';
import '../server/ai/index.js';
import '../server/assistant/index.js';
import '../server/import/index.js';
import '../server/inbox/index.js';

/** 配置库的中文名 → 短名。定下不改（改了要连快照、样例的文件名一起改） */
export const configDbKeys: Readonly<Record<string, string>> = {
  账号库: 'accounts',
  出错记录库: 'problem-log',
  'AI 设置库': 'ai-settings',
  提示词库: 'prompts',
  助手工具设置库: 'assistant-tools',
  'AI 识别工作区': 'import-workspaces',
  机器人设置库: 'bots',
};
/** 基线快照放在哪 */
export const CONFIG_BASELINE_DIRECTORY = fileURLToPath(new URL('../tests/fixtures/config-db/', import.meta.url));

type Spec = ReturnType<typeof registeredVersionedSqlite>[number];
/** 登记过的配置库，带上短名和基线快照的文件名；没登记短名的报错 */
export function configDatabases() {
  return registeredVersionedSqlite().map((spec) => {
    const key = configDbKeys[spec.label];
    if (!key) throw new Error(`配置库“${spec.label}”没有短名：在 scripts/config-db-dump.ts 的 configDbKeys 登记一个`);
    return { spec, key, file: `${key}-v${spec.baseline}.sql` };
  });
}

const objectRow = z.object({ sql: z.string() });
// 快照头也参与基线比对，原文保留。规格现位于 server/core/backup/versioned-sqlite-spec.ts。
const header = (spec: Spec) => `-- ${spec.label}第 ${spec.baseline} 版（基线）的结构快照：在一个全新的空文件上整份执行，建出来的就是这一版的库。
-- 用途：tests/config-db-evolution.test.ts 拿它当“从基线一路升级上来”的起点，核对升级上来的库和程序新建的库结构完全一样；
-- tests/upgrade-step-samples.test.ts 从它开始跑每一步的数据样例。
-- 怎么生成：npm run schema:dump（scripts/config-db-dump.ts，在内存里按规格的 create 建空库再导出）。
-- 定下以后不许改：要改结构在规格的 steps 里加升级步骤（规矩见 server/core/versioned-sqlite-spec.ts 开头）。
`;

/** 内存里按 create 建一个空库，导出成基线快照的全文。已经有升级步骤的库不能再导出 */
export function dumpConfigBaseline(spec: Spec) {
  if (spec.steps.length)
    throw new Error(`${spec.label}已经有升级步骤，create 建的不再是第 ${spec.baseline} 版：基线快照定下以后不许改，不能再导出。`);
  const db = openVersionedSqlite(':memory:', spec);
  try {
    const objects = db
      .prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
      .all()
      .map((row) => objectRow.parse(row).sql + ';');
    const text = [header(spec), 'BEGIN;', ...objects, `PRAGMA user_version=${spec.baseline};`, 'COMMIT;', ''].join('\n');
    if (text.includes('\r')) throw new Error('导出的内容里有回车符（\\r），换行必须统一是 LF');
    return text;
  } finally {
    db.close();
  }
}

/** 还没有升级步骤的库都导出一遍，返回写了哪些文件 */
export function writeConfigBaselines() {
  mkdirSync(CONFIG_BASELINE_DIRECTORY, { recursive: true });
  return configDatabases()
    .filter(({ spec }) => !spec.steps.length)
    .map(({ spec, file }) => {
      const target = join(CONFIG_BASELINE_DIRECTORY, file);
      writeFileSync(target, dumpConfigBaseline(spec));
      return target;
    });
}

// 备份测试共用的准备。建一份完整备份要建好几个库再整理、校验，所以每种样子只建一次，各条测试复制一份来改。
import { sales } from '../server/sales/index.js';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import {
  Store,
  openVersionedSqlite,
  createFullBackup,
  one,
  readBackupManifest,
} from '../server/core/index.js';
import { ImportRepository } from '../server/import/repository.js';
import { customerSchema } from '../shared/core/domain.js';
import { AuthManager } from '../server/accounts/index.js';
import { z } from 'zod';

/** 目录下每个文件的内容（base64），比较“一个字节没变”用 */
export function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else result[relative(root, path)] = readFileSync(path).toString('base64');
    }
  };
  walk(root);
  return result;
}

export const run = (sql: string) => (path: string) => {
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
};

export const versionOf = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = one(db, z.object({ user_version: z.number() }), 'PRAGMA user_version');
    if (!row) throw new Error('读不到 ' + path + ' 的 user_version');
    return row.user_version;
  } finally {
    db.close();
  }
};

/** 改备份里的一个数据库文件（默认是业务库），再把清单里的哈希改成对的：只剩“这个库本身不对”这一个拒绝理由 */
export function alterBackupDatabase(dir: string, change: (path: string) => void, name = 'erp.sqlite') {
  const path = join(dir, name);
  change(path);
  const manifestPath = join(dir, 'manifest.json');
  const manifest = readBackupManifest(dir),
    file = manifest.files.find((entry) => entry.path === name);
  if (!file) throw new Error('备份清单里没有 ' + name);
  file.sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return path;
}

/** 一个虚构的配置库（现在是第 2 版）：恢复前的校验对登记过的配置库都一样，不只认真实的那几个 */
export const fictionalNotes = {
  label: '虚构便签库',
  baseline: 2,
  steps: [],
  create(db: DatabaseSync) {
    db.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL, tag TEXT); CREATE INDEX notes_body ON notes(body)');
  },
};
export const noteMarker = 'fictional-marker-note';
/** 同一个虚构便签库，程序加了一步升到第 3 版（加一列）：备份里第 2 版的库就在基线和当前之间 */
const addPinned = (db: DatabaseSync) => db.exec('ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
export const fictionalNotesV3 = {
  ...fictionalNotes,
  steps: [{ version: 3, name: '虚构便签加置顶', up: addPinned }],
  create(db: DatabaseSync) {
    fictionalNotes.create(db);
    addPinned(db);
  },
};

/**
 * 带配置库的虚构数据目录和它的完整备份。账号库、AI 识别工作区用真的类建，另有一个虚构的配置库
 * （打开过，位置就登记了）、一个放在数据目录外的本机配置（备份时进 _extra），和一个没人登记的数据库文件。
 * 备份做完以后目标目录里又多了运行标记和一个旧目录（恢复时运行标记留着、别的换成备份里的）。
 */
async function buildConfigBackup(root: string) {
  const target = join(root, 'target'), local = join(root, 'config', 'local.sqlite');
  const store = new Store(join(target, 'erp.sqlite'));
  sales(store).createCustomer(customerSchema.parse({ name: '虚构配置库客户' }));
  store.close();
  new AuthManager(join(target, 'security', 'users.sqlite')).close();
  new ImportRepository(join(target, 'ai-imports', 'workspaces.sqlite')).close();
  const notes = openVersionedSqlite(join(target, 'notes', 'notes.sqlite'), fictionalNotes);
  notes.prepare('INSERT INTO notes(body) VALUES(?)').run(noteMarker);
  notes.close();
  openVersionedSqlite(local, fictionalNotes).close();
  mkdirSync(join(target, 'misc'));
  run('CREATE TABLE scraps(id INTEGER PRIMARY KEY, body TEXT); PRAGMA user_version=7')(join(target, 'misc', 'scraps.sqlite'));
  writeFileSync(join(target, 'misc', '虚构.bin'), new Uint8Array([0, 1, 2, 3]));
  await createFullBackup({ dataDir: target, backupRoot: join(root, 'copies'), extraFiles: { 'local.sqlite': local } });
  mkdirSync(join(target, 'old'));
  writeFileSync(join(target, 'old', '原文件.txt'), '虚构旧内容');
  writeFileSync(join(target, 'erp.sqlite.running'), '虚构运行标记');
}

let template: Promise<string> | undefined;
after(async () => {
  if (template) rmSync(await template, { recursive: true, force: true });
});

/** 这份备份复制一份到新的临时目录：{ root, target, local, backup.dir }，用完 close() */
export async function configFixture() {
  template ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'erp-backup-template-'));
    await buildConfigBackup(dir);
    return dir;
  })();
  const source = await template;
  const root = mkdtempSync(join(tmpdir(), 'erp-config-restore-'));
  cpSync(source, root, { recursive: true });
  const copies = join(root, 'copies');
  const target = join(root, 'target'), local = join(root, 'config', 'local.sqlite');
  // 配置库打开过一次，位置才登记上（恢复时按位置认是哪个库）；复制出来的新位置要再打开一次
  new AuthManager(join(target, 'security', 'users.sqlite')).close();
  new ImportRepository(join(target, 'ai-imports', 'workspaces.sqlite')).close();
  openVersionedSqlite(join(target, 'notes', 'notes.sqlite'), fictionalNotes).close();
  return {
    root,
    target,
    local,
    backup: { dir: join(copies, readdirSync(copies)[0]) },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

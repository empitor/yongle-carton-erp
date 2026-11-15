// AI 设置库的版本、读不了和多实例冲突（server/ai/settings-repository.ts、settings-manager.ts）：
// 0.8.4 留下的第 1 版库删掉重建；读不了时明确报错、写进日志、文件不动；两个实例共用一个库时冲突不覆盖、刷新后能接着存。
// 旧版本的库删掉重建、不是数据库的文件拒绝打开是统一规则（versioned-sqlite.test.ts）。只用临时目录和虚构的假密钥。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import type { AiSettingsManager } from '../server/ai/settings-manager.js';
import { fakeKey } from './fake-deepseek.js';
import { settingsAt, storedSettings, withTempDir } from './ai-settings-fixture.js';

/** 测试里放进库的假密文：日志里一个字都不许出现 */
const FAKE_CIPHERTEXT = 'opaque-fictional-ciphertext';
/** 0.8.4 存的样子：多套预设，没有 format */
const oldDocument = JSON.stringify({
  presets: [{ id: 'p1', name: '虚构老预设', provider: 'deepseek', model: 'deepseek-chat', encryptedKey: FAKE_CIPHERTEXT }],
  lastPresetId: 'p1',
  autoConnect: true,
  recognitionConcurrency: 2,
  revision: 3,
});

/** 照 0.8.4 和现在的程序都用的建表造一个库，里面放一行 document，记成第 version 版 */
function seed(file: string, document: string, version: number) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE ai_settings(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)');
  db.prepare('INSERT INTO ai_settings(id,document) VALUES(1,?)').run(document);
  db.exec('PRAGMA user_version=' + version);
  db.close();
}

type ErrorLog = { mock: { calls: { arguments: unknown[] }[] } };
const logLines = (logged: ErrorLog) => logged.mock.calls.map((call) => call.arguments.map(String).join(' '));
/** 读不了时：状态和保存都报“AI 设置库读不了”；[AI 设置] 那条日志写明文件和原因；日志里没有密文 */
function assertUnreadable(m: AiSettingsManager, logged: ErrorLog, file: string, reason: RegExp) {
  assert.match(String(m.view().storageError), /AI 设置库读不了/);
  assert.equal(m.status().ready, false);
  assert.throws(
    () => m.saveKey({ apiKey: fakeKey, expectedRevision: m.view().revision }),
    (e: unknown) => e instanceof Error && 'code' in e && e.code === 'storage' && /AI 设置库读不了/.test(e.message),
  );
  const own = logLines(logged).filter((line) => line.includes('[AI 设置]'));
  assert.ok(own.some((line) => line.includes(file) && reason.test(line)), '[AI 设置] 那条写明文件和原因：\n' + own.join('\n'));
  assert.ok(!logLines(logged).join('\n').includes(FAKE_CIPHERTEXT), '日志里没有密文');
}

test('0.8.4 留下的 AI 设置库（第 1 版、旧格式）：打开时删掉重建，重建后能保存密钥、重开读得回来', () =>
  withTempDir('erp-ai-upgrade-old-', (dir) => {
    const file = join(dir, 'settings.sqlite');
    seed(file, oldDocument, 1);
    let m = settingsAt(file);
    try {
      assert.equal(m.view().storageError, null);
      assert.equal(m.view().hasKey, false);
      const rebuilt = storedSettings(file);
      assert.equal(rebuilt.version, 2);
      assert.doesNotMatch(String(rebuilt.document), /虚构老预设/);
      m.saveKey({ apiKey: fakeKey, expectedRevision: m.view().revision });
    } finally {
      m.close();
    }
    m = settingsAt(file);
    try {
      assert.equal(m.view().hasKey, true);
      assert.equal(m.status().ready, true);
    } finally {
      m.close();
    }
  }));

test('第 2 版的库里读到别的格式、库比程序新：都报“AI 设置库读不了”、保存也拒，日志写明文件和原因，文件不动', (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  return withTempDir('erp-ai-settings-odd-', (dir) => {
    const cases = [
      { name: 'settings-v2.sqlite', version: 2, reason: /ai_settings\.document/ },
      { name: 'settings-newer.sqlite', version: 3, reason: /AI 设置库比当前程序新/ },
    ];
    for (const { name, version, reason } of cases) {
      const file = join(dir, name);
      seed(file, oldDocument, version);
      const before = readFileSync(file);
      const m = settingsAt(file);
      try {
        assertUnreadable(m, logged, file, reason);
      } finally {
        m.close();
      }
      assert.deepEqual(readFileSync(file), before, name + ' 文件不动');
    }
  });
});

test('两个实例共用一个库：版本冲突回 409、不覆盖别处存的，刷新后用新的版本号能存进去', () =>
  withTempDir('erp-ai-settings-conflict-', (dir) => {
    const file = join(dir, 'settings.sqlite');
    const a = settingsAt(file);
    a.saveKey({ apiKey: fakeKey, expectedRevision: a.view().revision });
    const b = settingsAt(file);
    try {
      a.preferences({ recognitionConcurrency: 5, expectedRevision: a.view().revision });
      assert.throws(
        () => b.preferences({ recognitionConcurrency: 1, expectedRevision: b.view().revision }),
        (e: unknown) => e instanceof Error && 'status' in e && e.status === 409 && /别处改过/.test(e.message) && !/磁盘/.test(e.message),
      );
      const fresh = settingsAt(file);
      try {
        assert.equal(fresh.view().recognitionConcurrency, 5, '冲突没有覆盖别处存的设置');
        assert.equal(fresh.view().hasKey, true);
      } finally {
        fresh.close();
      }
      assert.equal(b.view().recognitionConcurrency, 5, '冲突后读回别处存的设置');
      assert.equal(b.preferences({ recognitionConcurrency: 1, expectedRevision: b.view().revision }).recognitionConcurrency, 1);
    } finally {
      a.close();
      b.close();
    }
  }));

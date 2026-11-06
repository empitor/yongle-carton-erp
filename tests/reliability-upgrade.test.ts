import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  copyAutomaticBackup,
  createFullBackup,
  restoreFullBackup,
  snapshotBeforeUpgrade,
  supportedDatabaseVersions,
} from '../server/backup.js';
import { Store } from '../server/db.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceMonthly } from '../server/finance/monthly.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { migrateFinance } from '../server/finance/schema.js';
import { financePermissions } from '../shared/finance.js';

const oldSql = readFileSync(new URL('./fixtures/v0.6.1-business.sql', import.meta.url), 'utf8');
const supplement = readFileSync(new URL('./fixtures/v15-inbox-marks.sql', import.meta.url), 'utf8');
const businessTables = [
  'customers',
  'products',
  'orders',
  'order_lines',
  'purchases',
  'purchase_lines',
  'purchase_receipts',
  'stock_items',
  'stock_movements',
  'flow_documents',
  'record_lifecycle',
];
const inboxTables = ['inbox_items', 'inbox_files', 'product_marks', 'mark_files'];
const actor = { id: 'upgrade-finance', name: '虚构升级财务', permissions: [...financePermissions] };

function createOld(path: string, v15: boolean) {
  const db = new DatabaseSync(path);
  db.exec(oldSql);
  if (v15) db.exec(supplement);
  return db;
}
const history = (db: DatabaseSync) =>
  db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
const state = (db: DatabaseSync, tables: string[]) =>
  Object.fromEntries(
    tables.map((table) => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]),
  );
const stock = (db: DatabaseSync) =>
  db
    .prepare(
      'SELECT item_id,sum(delta_units) AS balance FROM stock_movements GROUP BY item_id ORDER BY item_id',
    )
    .all();

test('标签旧库及带收件箱、唛头的 v15 库升级保留业务数据，重复打开不会重跑迁移', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-upgrade-test-'));
  const handles: DatabaseSync[] = [];
  try {
    for (const withInbox of [false, true]) {
      const dataDir = join(dir, withInbox ? 'v15' : 'tag');
      mkdirSync(dataDir);
      const path = join(dataDir, 'erp.sqlite');
      const old = createOld(path, withInbox);
      handles.push(old);
      const tables = withInbox ? [...businessTables, ...inboxTables] : businessTables;
      const before = state(old, tables),
        beforeStock = stock(old);
      assert.equal(history(old).at(-1)?.version, withInbox ? 15 : 13);
      // 快照须含仍在 WAL 中的提交。
      old.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE upgrade_wal_probe(value TEXT); INSERT INTO upgrade_wal_probe VALUES('已提交');",
      );
      const snapshot = snapshotBeforeUpgrade(path);
      assert.ok(snapshot);
      const saved = new DatabaseSync(snapshot, { readOnly: true });
      handles.push(saved);
      assert.equal(saved.prepare('SELECT value FROM upgrade_wal_probe').get()?.value, '已提交');
      assert.deepEqual(state(saved, tables), before);
      assert.equal(history(saved).at(-1)?.version, withInbox ? 15 : 13);
      saved.close();
      old.close();
      const upgraded = new Store(path);
      handles.push(upgraded.db);
      assert.deepEqual(state(upgraded.db, tables), before);
      assert.deepEqual(stock(upgraded.db), beforeStock);
      const applied = history(upgraded.db);
      assert.deepEqual(
        applied.map((r) => r.version),
        supportedDatabaseVersions,
      );
      assert.equal(snapshotBeforeUpgrade(path), null);
      upgraded.close();
      const reopened = new Store(path);
      handles.push(reopened.db);
      assert.deepEqual(history(reopened.db), applied);
      const events = new FinanceEvents(reopened);
      const report = new FinanceMonthly(reopened);
      new FinanceSettings(reopened).enable(actor, {
        requestId: 'upgrade-enable',
        version: 1,
        period: '2026-10',
        taxpayer: 'general',
        rows: [],
      });
      assert.equal(report.get(actor, { period: '2026-10' }).missingTax, 2);
      assert.equal(events.sync(actor, { requestId: 'upgrade-events' }).processed, 4);
      const delivery = events.list(actor, {}).rows.find((row) => row.source_id === '3')!;
      assert.equal(delivery.status, 'info_pending');
      const corrected = events.resolve(actor, delivery.id, {
        version: delivery.version,
        requestId: 'upgrade-tax',
        evidence: '虚构合同补税',
        lines: [{ exact: '24.6000000', mode: '未税', rate: '13' }],
      });
      assert.equal(corrected.amount_cents, 2780);
      assert.ok(
        corrected.voucher_id ??
          events.generate(actor, delivery.id, {
            version: corrected.version,
            requestId: 'upgrade-voucher',
          }).voucher_id,
      );
      const physical = reopened.db.prepare('SELECT document FROM flow_documents WHERE id=3').get()!;
      const missing = JSON.parse(String(physical.document));
      delete missing.lines[0].unitPriceExact;
      reopened.db
        .prepare('UPDATE flow_documents SET document=?,version=version+1 WHERE id=3')
        .run(JSON.stringify(missing));
      const details = report.detail(actor, { period: '2026-10', metric: 'theoreticalIncome' }).rows;
      assert.equal(details[0].amount, null);
      assert.equal(report.get(actor, { period: '2026-10' }).missingPrice, 1);
      if (withInbox) {
        const bytes = Buffer.from([0, 35, 127, 255]);
        writeFileSync(join(dataDir, 'fictional.bin'), bytes);
        mkdirSync(join(dataDir, 'security'));
        const users = new DatabaseSync(join(dataDir, 'security', 'users.sqlite'));
        try {
          users.exec(`CREATE TABLE auth_sessions(token_hash TEXT,user_id TEXT,expires INTEGER);
            INSERT INTO auth_sessions VALUES('fictional-token-hash','fictional-user',1);`);
        } finally {
          users.close();
        }
        const backup = await createFullBackup({
          dataDir,
          backupRoot: join(dir, 'backups'),
          prefix: 'auto',
        });
        const replica = join(dir, 'replica');
        mkdirSync(replica);
        const oldCopy = join(replica, 'auto-2000-01-01T00-00-00-000Z-000000');
        mkdirSync(oldCopy);
        mkdirSync(join(replica, 'keep-other-files'));
        await copyAutomaticBackup(backup.dir, replica);
        await copyAutomaticBackup(backup.dir, replica);
        assert.ok(existsSync(oldCopy));
        await copyAutomaticBackup(backup.dir, replica, 1);
        assert.equal(existsSync(oldCopy), false);
        assert.ok(existsSync(join(replica, 'keep-other-files')));
        const copied = join(replica, backup.dir.split(/[\\/]/).at(-1)!);
        assert.deepEqual(
          readFileSync(join(copied, 'manifest.json')),
          readFileSync(join(backup.dir, 'manifest.json')),
        );
        const tampered = JSON.parse(readFileSync(join(copied, 'manifest.json'), 'utf8'));
        tampered.files[0].path = '../outside.sqlite';
        writeFileSync(join(copied, 'manifest.json'), JSON.stringify(tampered));
        assert.throws(() => restoreFullBackup(copied, join(dir, 'rejected')), /无效路径/);
        assert.equal(existsSync(join(dir, 'rejected')), false);
        writeFileSync(
          join(copied, 'manifest.json'),
          readFileSync(join(backup.dir, 'manifest.json')),
        );
        const fresh = join(dir, 'fresh');
        assert.equal(existsSync(fresh), false);
        await restoreFullBackup(copied, fresh);
        assert.deepEqual(readFileSync(join(fresh, 'fictional.bin')), bytes);
        assert.deepEqual(
          readFileSync(join(fresh, 'erp.sqlite')),
          readFileSync(join(copied, 'erp.sqlite')),
        );
        const restoredUsers = new DatabaseSync(join(fresh, 'security', 'users.sqlite'), {
          readOnly: true,
        });
        try {
          assert.equal(
            restoredUsers.prepare('SELECT count(*) AS n FROM auth_sessions').get()?.n,
            0,
          );
        } finally {
          restoredUsers.close();
        }
        const restored = new Store(join(fresh, 'erp.sqlite'));
        try {
          assert.deepEqual(state(restored.db, tables), state(reopened.db, tables));
          assert.deepEqual(stock(restored.db), beforeStock);
          assert.equal(restored.db.prepare('SELECT count(*) AS n FROM fin_vouchers').get()?.n, 1);
        } finally {
          restored.close();
        }
      }
      reopened.close();
    }
  } finally {
    for (const db of handles) if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第 16、17 版迁移在 DDL 中途失败时回滚，快照失败时原库版本不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-upgrade-failure-'));
  try {
    for (const version of [16, 17]) {
      const parent = join(dir, String(version));
      mkdirSync(parent);
      const path = join(parent, 'erp.sqlite');
      const old = createOld(path, true);
      if (version === 17) migrateFinance(old);
      old.exec(
        `CREATE TABLE ${version === 16 ? 'fin_opening' : 'fin_cash_accounts'}(obstruction TEXT)`,
      );
      const schema = (db: DatabaseSync) =>
        db
          .prepare(
            "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all();
      const before = schema(old),
        applied = history(old),
        rows = state(old, [...businessTables, ...inboxTables]);
      old.close();
      writeFileSync(join(parent, 'snapshots'), '模拟无可用快照目录');
      assert.throws(() => snapshotBeforeUpgrade(path), /快照失败，未启动数据库迁移/);
      assert.throws(() => new Store(path), /already exists/);
      const unchanged = new DatabaseSync(path, { readOnly: true });
      try {
        assert.deepEqual(schema(unchanged), before);
        assert.deepEqual(history(unchanged), applied);
        assert.deepEqual(state(unchanged, [...businessTables, ...inboxTables]), rows);
      } finally {
        unchanged.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

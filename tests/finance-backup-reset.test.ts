// 财务数据在完整备份和初始化里的处理：备份保留附件字节，初始化碰到已结账期间要重新预览（虚构数据、临时目录和内存库）
// 加载业务、财务、识别导入、单据导出模块：初始化要它们登记的清空规则
import '../server/overview/index.js';
import '../server/finance/index.js';
import '../server/import/index.js';
import '../server/documents/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/core/db.js';
import { SCHEMA_LATEST } from '../server/core/schema/index.js';
import { createFullBackup, restoreFullBackup } from '../server/core/backup.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { BusinessReset } from '../server/admin/business-reset.js';
import { FinanceAttachments } from '../server/finance/attachments.js';
import { maker, newSettings } from './finance-fixture.js';

test('完整备份恢复后财务附件的字节原样都在', async () => {
  const root = mkdtempSync(join(tmpdir(), 'erp-finance-backup-'));
  const data = join(root, 'data'),
    restore = join(root, 'restore');
  mkdirSync(data);
  const s = new Store(join(data, 'erp.sqlite'));
  try {
    newSettings(s);
    const bytes = Buffer.from('%PDF-虚构验收');
    const attachment = new FinanceAttachments(s).save(maker, { filename: 'fixture.pdf', requestId: 'file' }, bytes);
    const backup = await createFullBackup({ dataDir: data, backupRoot: join(root, 'backup') });
    assert.equal(existsSync(restore), false);
    restoreFullBackup(backup.dir, restore);
    const copy = new Store(join(restore, 'erp.sqlite'));
    try {
      assert.deepEqual(Buffer.from(new FinanceAttachments(copy).get(maker, attachment.id).bytes as Uint8Array), bytes);
      assert.equal(copy.db.prepare('SELECT max(version) AS n FROM schema_migrations').get()?.n, SCHEMA_LATEST);
    } finally {
      copy.close();
    }
  } finally {
    s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('有已结账期间时初始化业务数据：不勾选清财务被拒，按预览的摘要确认后清掉财务数据、留下科目和模板', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    new FinanceAttachments(s).save(maker, { filename: 'fixture.pdf', requestId: 'file' }, Buffer.from('%PDF-虚构'));
    const local = localAdministratorActor(maker);
    const reset = new BusinessReset(s);
    s.db.exec("UPDATE fin_periods SET status='closed' WHERE period='2026-01'");
    assert.throws(() => reset.execute({ scope: 'business' }, local), /初始化预览/);
    const preview = reset.preview('business', local, { clearClosedFinance: true });
    assert.equal(preview.tables.fin_attachments, 1);
    assert.ok(preview.finance?.digest);
    reset.execute({ scope: 'business', clearClosedFinance: true, financeDigest: preview.finance.digest }, local);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM fin_attachments').get()?.n, 0);
    assert.ok(s.db.prepare('SELECT 1 FROM fin_accounts LIMIT 1').get());
    assert.ok(s.db.prepare('SELECT 1 FROM fin_templates LIMIT 1').get());
    assert.doesNotThrow(() => reset.execute({ scope: 'business' }, local));
  } finally {
    s.close();
  }
});

test('有已结账期间时初始化业务数据：预览以后又多了记录，带旧摘要被拒（409 preview-changed）、一条都不清', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const files = new FinanceAttachments(s);
    files.save(maker, { filename: 'fixture.pdf', requestId: 'file' }, Buffer.from('%PDF-虚构'));
    const local = localAdministratorActor(maker);
    const reset = new BusinessReset(s);
    s.db.exec("UPDATE fin_periods SET status='closed' WHERE period='2026-01'");
    const preview = reset.preview('business', local, { clearClosedFinance: true });
    files.save(maker, { filename: 'later.pdf', requestId: 'file-later' }, Buffer.from('%PDF-虚构后来的'));
    const finance = preview.finance;
    assert.ok(finance, '预览带财务那一段');
    assert.throws(
      () => reset.execute({ scope: 'business', clearClosedFinance: true, financeDigest: finance.digest }, local),
      (e: unknown) =>
        typeof e === 'object' && e !== null && 'status' in e && e.status === 409 && 'code' in e && e.code === 'preview-changed',
    );
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM fin_attachments').get()?.n, 2);
  } finally {
    s.close();
  }
});

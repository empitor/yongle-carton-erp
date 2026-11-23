// 数据管理的删除只有一条路：数据管理命令（/management/execute）只办改、归档、恢复、确认、撤销、取消，不收删除；
// 数据管理页删业务记录打开的是业务页面同一个删除窗（src/recordkit/DatabaseDeleteDialog.tsx，发 /deletions/execute）。
// 删除本身的权限、版本、防重复、审计、快照由删除引擎的测试守着（delete-permissions、snapshots、local-administration）。虚构数据。
import { sales } from '../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import LinkedDialogs, { linkedDelete } from '../src/admin/LinkedDialogs.js';
import DatabaseDeleteDialog from '../src/recordkit/DatabaseDeleteDialog.js';
import { AUDIT_SOURCE } from '../shared/core/audit-sources.js';
import { customerSchema } from '../shared/core/domain.js';
import { AppError } from '../server/core/errors.js';
import { count } from '../server/core/index.js';
import { basics, command } from './data-management-fixture.js';

const noop = () => {};

test('数据管理命令收到删除：说一句中文“删除请用删除功能”，记录还在、不留删除审计', () => {
  const f = basics();
  try {
    const row = sales(f.store).order(f.order.id, true);
    assert.ok(row);
    assert.throws(
      () => f.service.execute({ ...command('orders', 'delete', [row]), entry: AUDIT_SOURCE.dataManagement }, f.who, 's'),
      (e: unknown) => e instanceof AppError && e.status === 400 && /删除请用删除功能/.test(e.message) && !/[A-Za-z]/.test(e.message),
    );
    assert.ok(sales(f.store).order(row.id, true), '订单还在');
    assert.equal(count(f.store.db, "SELECT COUNT(*) FROM business_audit WHERE action='delete'"), 0);
  } finally {
    f.store.close();
  }
});

test('数据管理页点删除：业务记录打开的就是业务页面的删除窗（同样的标题、提醒和按钮）；识别文件用自己的确认窗', () => {
  const customer = { record: { id: 7, version: 2, name: '虚构待删客户' }, input: customerSchema.parse({ name: '虚构待删客户' }) };
  const linked = linkedDelete('customers', [customer]);
  assert.ok(linked);
  const shown = renderToStaticMarkup(h(LinkedDialogs, { linked, close: noop, finished: noop }));
  assert.equal(shown, renderToStaticMarkup(h(DatabaseDeleteDialog, { module: 'customers', rows: [customer.record], close: noop, done: noop })));
  assert.match(shown, /删除后不能恢复/);
  const file = { record: { id: '虚构识别文件', version: 1, archived: false, name: '虚构.png' }, input: undefined };
  assert.equal(linkedDelete('workspaces', [file]), null);
});

// 审计来源只表示从哪个入口来（shared/core/audit-sources.ts）：入口把来源标在账号上，服务照账号记，自己不写来源。
// 同一个服务被页面、助手、数据管理共用时，记下来的来源分得清是哪边来的。
import { sales } from '../../server/sales/index.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DataManagementService } from '../../server/admin/data-management-service.js';
import { recordContext } from '../../server/overview/record-context.js';
import { localAdministratorActor } from '../../server/core/index.js';
import { AUDIT_SOURCE, auditSourceNames } from '../../shared/core/audit-sources.js';
import { customerSchema } from '../../shared/core/domain.js';
import { assistantFixture, confirmCard } from '../support/assistant-fixture.js';
import { startHttp } from '../support/http-fixture.js';
import { actor, superActor } from '../support/actor-fixture.js';

test('归档客户：页面、助手、数据管理三个入口各做一次，审计来源分别记页面、助手、数据管理，修改历史写中文', async () => {
  const f = assistantFixture();
  const h = await startHttp(f.store);
  try {
    const [a, b, c] = ['虚构来源甲', '虚构来源乙', '虚构来源丙'].map((name) =>
      sales(f.store).createCustomer(customerSchema.parse({ name })),
    );
    // 页面：登录后在客户页上归档（records-router.ts 把登录账号原样交给服务）
    const page = await h.post('/customers/batch', { action: 'archive', acknowledged: true, items: [{ id: a.id, version: a.version }] });
    assert.equal(page.status, 200, await page.clone().text());
    // 助手：对话里出归档卡片，人点确认
    const thread = f.manager.create(actor);
    f.replies.push(
      { message: '', toolCalls: [{ name: 'records.propose_lifecycle', args: { module: 'customers', id: b.id, action: 'archive' } }] },
      { message: '出了归档卡片，确认后归档。' },
    );
    await confirmCard(f, await f.say(thread.id, '把虚构来源乙归档'), 0, actor, 's');
    // 数据管理：数据管理窗口发的命令带入口标记（src/admin/data-api.ts 的 dataManagementCommand）
    new DataManagementService(f.store).execute(
      {
        requestId: randomUUID(),
        module: 'customers',
        action: 'archive',
        items: [{ id: c.id, version: c.version }],
        patch: {},
        reason: '虚构维护',
        entry: AUDIT_SOURCE.dataManagement,
      },
      localAdministratorActor(superActor()),
      's',
    );
    const sources = (id: number) =>
      f.store.db
        .prepare("SELECT DISTINCT source FROM business_audit WHERE entity='customers' AND record_id=? AND action='archive'")
        .all(id)
        .map((r) => r.source);
    assert.deepEqual(sources(a.id), [AUDIT_SOURCE.page]);
    assert.deepEqual(sources(b.id), [AUDIT_SOURCE.assistant]);
    assert.deepEqual(sources(c.id), [AUDIT_SOURCE.dataManagement], '归档服务记的和数据管理补记带原因的那条都是数据管理');
    // 修改历史只给中文叫法
    const labels = (id: number) => recordContext(f.store, 'customers', id, superActor()).history.map((e) => e.sourceLabel);
    assert.deepEqual(labels(a.id), [auditSourceNames.page]);
    assert.deepEqual(labels(b.id), [auditSourceNames.assistant]);
    assert.deepEqual(labels(c.id), [auditSourceNames['data-management'], auditSourceNames['data-management']]);
  } finally {
    await h.close();
    f.close();
  }
});

// 识别任务和原件的来源：同一原件复用哪个任务、到货单核对后锁定识别类型、收件转识别、到货原件按哈希查重。
// 只用临时目录、:memory: 库和虚构数据。
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { Store } from '../server/core/db.js';
import type { Actor } from '../server/core/auth.js';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { ImportManager } from '../server/import/manager.js';
import { importRouter } from '../server/import/router.js';
import { InboxService } from '../server/inbox/service.js';
import { ReceiptAi } from '../server/import/receipt-ai.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { testProtector as protector } from './fake-deepseek.js';
import { tempDir } from './order-import-fixture.js';

const actor: Actor = pageActor({ id: 'audit-fixture', name: '虚构验收员', permissions: ['business:edit'] });

const owner = () =>
  localAdministratorActor({
    ...actor,
    role: 'super_admin',
    superAdminMode: true,
    superAdminUntil: Date.now() + 120000,
  });

/** 只有 PNG 文件头的虚构原件，内容不同哈希就不同。 */
const png = (tag: string) =>
  Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('虚构原件-' + tag)]);

function fixture() {
  const temp = tempDir('erp-import-sources-'),
    dir = temp.dir,
    store = new Store(':memory:'),
    settings = new AiSettingsManager({ protector }),
    receiptPrompts = new PromptPresetManager(':memory:'),
    manager = new ImportManager({ directory: join(dir, 'imports'), settings }),
    receiptAi = new ReceiptAi(store, settings, receiptPrompts);
  const arrivalDoc = (status: 'draft' | 'confirmed' | 'cancelled') =>
    Number(
      store.db
        .prepare(
          "INSERT INTO flow_documents(kind,number,date,status,document,actor_id,actor_name,created_at,updated_at) VALUES('arrival',?,?,?,?,?,?,?,?)",
        )
        .run(
          'DH-虚构-' + randomUUID().slice(0, 8),
          '2026-11-01',
          status,
          '{}',
          actor.id,
          actor.name,
          new Date().toISOString(),
          new Date().toISOString(),
        ).lastInsertRowid,
    );
  return {
    dir,
    store,
    settings,
    manager,
    receiptAi,
    arrivalDoc,
    close() {
      manager.close();
      receiptPrompts.close();
      settings.close();
      store.close();
      temp.remove();
    },
  };
}

test('同一原件只复用同类型、没归档、没关联到货的任务', async () => {
  const f = fixture();
  try {
    const bytes = png('复用');
    const first = (await f.manager.upload(bytes, '虚构.png')).workspace;
    assert.equal(first.mode, 'order');
    // 未处理的同类型任务照旧复用
    const again = await f.manager.upload(bytes, '虚构.png');
    assert.equal(again.duplicate, true);
    assert.equal(again.workspace.id, first.id);

    // 换成到货单后，按订单上传不能拿到这个到货任务
    f.manager.setMode(first.id, { expectedRevision: first.revision, mode: 'arrival' });
    const asOrder = await f.manager.upload(bytes, '虚构.png');
    assert.equal(asOrder.duplicate, false);
    assert.notEqual(asOrder.workspace.id, first.id);
    assert.equal(asOrder.workspace.mode, 'order');
    // 按到货上传：没关联到货原件的到货任务可以复用
    const asArrival = await f.manager.upload(bytes, '虚构.png', false, 'arrival');
    assert.equal(asArrival.workspace.id, first.id);
    assert.equal(asArrival.duplicate, true);
    // 关联了到货原件以后就不复用，新建独立任务，原任务不动
    const linked = f.manager.get(first.id);
    f.manager.linkArrival(first.id, {
      expectedRevision: linked.revision,
      docId: null,
      sourceId: randomUUID(),
    });
    const isolated = await f.manager.upload(bytes, '虚构.png', false, 'arrival');
    assert.equal(isolated.duplicate, false);
    assert.equal(isolated.workspace.mode, 'arrival');
    assert.notEqual(isolated.workspace.id, first.id);
    assert.equal(f.manager.get(first.id).mode, 'arrival');

    // 已归档的任务不复用
    const archivedBytes = png('归档');
    const archived = (await f.manager.upload(archivedBytes, '归档.png')).workspace;
    f.manager.changeArchive({ action: 'archive', items: [{ id: archived.id, version: archived.revision }] }, owner());
    const afterArchive = await f.manager.upload(archivedBytes, '归档.png');
    assert.equal(afterArchive.duplicate, false);
    assert.notEqual(afterArchive.workspace.id, archived.id);

  } finally {
    f.close();
  }
});

test('到货单已确认或取消就锁定识别类型；锁在 setMode 里，路由接好后页面、收件箱、助手共用', async () => {
  const f = fixture();
  try {
    // 挂载路由时注入锁定判断
    importRouter(f.manager, () => actor, f.receiptAi);
    const confirmed = f.arrivalDoc('confirmed'),
      draft = f.arrivalDoc('draft');
    assert.equal(f.manager.arrivalLocked(confirmed), true);
    assert.equal(f.manager.arrivalLocked(draft), false);

    let w = (await f.manager.upload(png('锁定'), '锁定.png', false, 'arrival')).workspace;
    w = f.manager.linkArrival(w.id, { expectedRevision: w.revision, docId: confirmed, sourceId: null });
    assert.throws(
      () => f.manager.setMode(w.id, { expectedRevision: w.revision, mode: 'order' }),
      /识别类型已锁定/,
    );
    assert.equal(f.manager.get(w.id).mode, 'arrival');

    // 到货单还是草稿时照常可以换
    let open = (await f.manager.upload(png('草稿'), '草稿.png', false, 'arrival')).workspace;
    open = f.manager.linkArrival(open.id, { expectedRevision: open.revision, docId: draft, sourceId: null });
    assert.equal(
      f.manager.setMode(open.id, { expectedRevision: open.revision, mode: 'order' }).mode,
      'order',
    );
  } finally {
    f.close();
  }
});

test('收件转订单拿到的任务类型和要求一致，到货任务原样保留；不能再转唛头', async () => {
  const f = fixture();
  try {
    importRouter(f.manager, () => actor, f.receiptAi);
    const inbox = new InboxService(f.store);
    const bytes = png('收件');
    // 同一文件之前已在 AI 导入里作为到货单处理，并关联了已确认的到货单
    let arrival = (await f.manager.upload(bytes, '收件.png', false, 'arrival')).workspace;
    arrival = f.manager.linkArrival(arrival.id, {
      expectedRevision: arrival.revision,
      docId: f.arrivalDoc('confirmed'),
      sourceId: null,
    });
    const ingest = (externalId: string) =>
      inbox.ingest({
        channel: 'manual',
        externalId,
        kind: 'image',
        receivedAt: '2026-11-05T10:00:00Z',
        file: { name: '收件.png', mime: 'image/png', bytes: new Uint8Array(bytes) },
      });

    const forOrder = ingest('fictional-order');
    const toOrder = await inbox.toImport(
      Number(forOrder.id),
      { kind: 'order', expectedVersion: forOrder.version },
      actor,
      f.manager,
    );
    assert.notEqual(toOrder.workspaceId, arrival.id);
    assert.equal(f.manager.get(toOrder.workspaceId).mode, 'order');
    assert.equal(toOrder.item.convertedKind, 'order');

    const forMark = ingest('fictional-mark');
    await assert.rejects(
      inbox.toImport(Number(forMark.id), { kind: 'mark', expectedVersion: forMark.version }, actor, f.manager),
      (e: unknown) => e instanceof ZodError && e.issues.some((i) => i.path[0] === 'kind'),
      '唛头不识别，收件不能转唛头',
    );
    assert.equal(inbox.get(Number(forMark.id)).status, 'pending');
    const kept = f.manager.get(arrival.id);
    assert.equal(kept.mode, 'arrival');
    assert.equal(kept.arrivalDocId, arrival.arrivalDocId);
  } finally {
    f.close();
  }
});

test('到货原件按哈希直接查，不把全部记录读出来', (t) => {
  const f = fixture();
  try {
    t.mock.method(f.receiptAi, 'sources', () => assert.fail('上传查重不能全量读取到货原件'));
    const bytes = png('哈希');
    const receipt = f.receiptAi.upload(bytes, '虚构.png', actor);
    assert.equal('duplicate' in receipt ? receipt.duplicate : undefined, undefined);
    const receiptAgain = f.receiptAi.upload(bytes, '虚构.png', actor);
    assert.equal(receiptAgain.id, receipt.id);
    assert.ok('duplicate' in receiptAgain);
    assert.equal(receiptAgain.duplicate, true);
  } finally {
    f.close();
  }
});

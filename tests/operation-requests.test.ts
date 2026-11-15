// 防重复提交记录（operation_requests）、按天的流水号计数（number_sequences）和每日清理
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import {
  OPERATION_REQUEST_KEEP_DAYS,
  REQUEST_REUSED,
  onceByRequest,
  operationRequest,
  purgeOperationRequests,
  replayRequest,
  requestDone,
  saveRequest,
  updateRequestResult,
} from '../server/core/requests.js';
import { peekSequence, takeSequence } from '../server/core/sequences.js';
import { AppError, StoredDataError } from '../server/core/errors.js';
import { count, one, pragmaInteger } from '../server/core/sql.js';
import { rows } from '../server/core/schema/rows.js';
import { runCleanup, scheduleDailyCleanup } from '../server/core/cleanup.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DAY = 86400_000;
const kinds = (store: Store) =>
  store.db
    .prepare('SELECT kind FROM operation_requests ORDER BY kind')
    .all()
    .map((r) => String(r.kind));
/** 直接存一条记录用（不经 onceByRequest） */
const record = (kind: string, requestId: string, digest = 'd') => ({ kind, actorId: 'fictional-user', requestId, digest });
const age = (store: Store, kind: string, days: number) =>
  store.db
    .prepare('UPDATE operation_requests SET created_at=? WHERE kind=?')
    .run(new Date(Date.now() - days * DAY).toISOString(), kind);

test('防重复提交记录带时间：保存时记下，结果必须是 JSON，同一个请求号存不了两次', () => {
  const store = new Store(':memory:');
  try {
    const before = Date.now();
    saveRequest(store, record('flow-save', 'fictional-1'), { ok: true });
    const row = one(store.db, rows.operation_requests, "SELECT * FROM operation_requests WHERE kind='flow-save'");
    assert.ok(row, '记下了这条防重复记录');
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Date.parse(row.created_at) >= before && Date.parse(row.created_at) <= Date.now());
    assert.deepEqual(JSON.parse(row.result), { ok: true });
    assert.throws(() => saveRequest(store, record('flow-save', 'fictional-1'), {}), /UNIQUE/);
    assert.throws(
      () =>
        store.db
          .prepare("INSERT INTO operation_requests(kind,actor_id,request_id,digest,created_at,result) VALUES('flow-save','u','fictional-2','d','t','不是JSON')")
          .run(),
      /CHECK/,
    );
    assert.deepEqual(kinds(store), ['flow-save']);
  } finally {
    store.close();
  }
});

test('补写结果只改摘要一致的那条', () => {
  const store = new Store(':memory:');
  try {
    saveRequest(store, record('workspace-management', 'fictional-1', 'digest-1'), { pending: true });
    const result = (): unknown => {
      const row = one(store.db, rows.operation_requests.pick({ result: true }), "SELECT result FROM operation_requests WHERE request_id='fictional-1'");
      if (!row) throw new Error('测试数据：没有 fictional-1 这条防重复记录');
      return JSON.parse(row.result);
    };
    updateRequestResult(store, record('workspace-management', 'fictional-1', '别的摘要'), { done: true });
    assert.deepEqual(result(), { pending: true });
    updateRequestResult(store, record('workspace-management', 'fictional-1', 'digest-1'), { done: true });
    assert.deepEqual(result(), { done: true });
  } finally {
    store.close();
  }
});

// 带请求号的写入：write 往临时表里加一行，数一数办了几次；saved 是结果的结构
const saved = z.object({ saved: z.number() });
const onceSetup = () => {
  const store = new Store(':memory:');
  store.db.exec('CREATE TEMP TABLE fictional_writes(n INTEGER)');
  let runs = 0;
  const writes = () => count(store.db, 'SELECT COUNT(*) n FROM fictional_writes');
  const request = (input: unknown, actor = 'fictional-user', session?: string) =>
    operationRequest('fictional-kind', 'fictional-1', { id: actor }, input, session);
  const write = (fail = false) => () => {
    runs++;
    store.db.prepare('INSERT INTO fictional_writes(n) VALUES(?)').run(runs);
    if (fail) throw new Error('虚构写入失败');
    return { saved: runs };
  };
  return { store, writes, request, write, runs: () => runs };
};

test('同一个请求号、同样的内容再来：原样返回上次的结果，不再办第二次', () => {
  const { store, writes, request, write, runs } = onceSetup();
  try {
    assert.equal(requestDone(store, 'fictional-kind', { id: 'fictional-user' }, 'fictional-1'), false);
    assert.equal(replayRequest(store, request({ a: 1 }), saved), undefined);
    assert.deepEqual(onceByRequest(store, request({ a: 1 }), write(), saved), { saved: 1 });
    assert.equal(requestDone(store, 'fictional-kind', { id: 'fictional-user' }, 'fictional-1'), true);
    assert.deepEqual(onceByRequest(store, request({ a: 1 }), write(), saved), { saved: 1 });
    assert.equal(runs(), 1);
    assert.equal(writes(), 1);
    // 别的种类用同一个号不算重复
    assert.deepEqual(onceByRequest(store, { ...request({ a: 1 }), kind: 'fictional-other' }, write(), saved), { saved: 2 });
  } finally {
    store.close();
  }
});

test('同一个账号的同一个请求号换了内容、（带会话的）换了会话：409 拒绝，不办', () => {
  const { store, writes, request, write, runs } = onceSetup();
  try {
    onceByRequest(store, request({ a: 1 }, 'fictional-user', 'fictional-session'), write(), saved);
    for (const other of [
      request({ a: 2 }, 'fictional-user', 'fictional-session'),
      request({ a: 1 }, 'fictional-user', 'fictional-other-session'),
    ]) {
      assert.throws(
        () => onceByRequest(store, other, write(), saved),
        (e: unknown) => e instanceof AppError && e.status === 409 && e.message === REQUEST_REUSED,
      );
      assert.throws(() => replayRequest(store, other, saved), (e: unknown) => e instanceof AppError && e.status === 409);
    }
    assert.equal(runs(), 1);
    assert.equal(writes(), 1);
  } finally {
    store.close();
  }
});

test('请求号按账号分开：别的账号用同一个请求号是另一个请求，各办各的，各自重发各自原样返回', () => {
  const { store, writes, request, write } = onceSetup();
  try {
    assert.deepEqual(onceByRequest(store, request({ a: 1 }), write(), saved), { saved: 1 });
    assert.deepEqual(onceByRequest(store, request({ a: 2 }, 'fictional-other-user'), write(), saved), { saved: 2 });
    assert.deepEqual(onceByRequest(store, request({ a: 1 }), write(), saved), { saved: 1 });
    assert.deepEqual(onceByRequest(store, request({ a: 2 }, 'fictional-other-user'), write(), saved), { saved: 2 });
    assert.equal(writes(), 2);
  } finally {
    store.close();
  }
});

test('同号重发时库里存的上次结果不合结构：抛 StoredDataError（回 500），不再办第二次', (t) => {
  const { store, writes, request, write, runs } = onceSetup();
  const logged = t.mock.method(console, 'error', () => {});
  try {
    onceByRequest(store, request({ a: 1 }), write(), saved);
    store.db.prepare("UPDATE operation_requests SET result=? WHERE kind='fictional-kind'").run(JSON.stringify({ saved: '不是数' }));
    assert.throws(
      () => onceByRequest(store, request({ a: 1 }), write(), saved),
      (e: unknown) => e instanceof StoredDataError && e.status === 500,
    );
    assert.throws(() => replayRequest(store, request({ a: 1 }), saved), StoredDataError);
    assert.equal(runs(), 1);
    assert.equal(writes(), 1);
    assert.equal(logged.mock.callCount(), 2, '每次都写一行服务端日志');
  } finally {
    store.close();
  }
});

test('写入失败：办了的整段撤回，不留请求记录，同一个号之后还能重新办', () => {
  const { store, writes, request, write } = onceSetup();
  try {
    assert.throws(() => onceByRequest(store, request({ a: 1 }), write(true), saved), /虚构写入失败/);
    assert.equal(writes(), 0);
    assert.equal(requestDone(store, 'fictional-kind', { id: 'fictional-user' }, 'fictional-1'), false);
    assert.deepEqual(onceByRequest(store, request({ a: 1 }), write(), saved), { saved: 2 });
    assert.equal(writes(), 1);
  } finally {
    store.close();
  }
});

test('过了保留期的防重复记录清掉，没到期的留着', () => {
  const store = new Store(':memory:');
  try {
    saveRequest(store, record('flow-save', 'fictional-1'), {});
    saveRequest(store, record('movement', 'fictional-3'), {});
    assert.equal(purgeOperationRequests(store), 0, '刚记下的不清');
    age(store, 'flow-save', OPERATION_REQUEST_KEEP_DAYS + 1);
    age(store, 'movement', OPERATION_REQUEST_KEEP_DAYS - 1);
    assert.equal(purgeOperationRequests(store), 1);
    assert.deepEqual(kinds(store), ['movement']);
    assert.equal(purgeOperationRequests(store), 0);
    // 保留天数和“现在”都可以指定
    assert.equal(purgeOperationRequests(store, OPERATION_REQUEST_KEEP_DAYS, new Date(Date.now() + 2 * DAY)), 1);
    assert.deepEqual(kinds(store), []);
  } finally {
    store.close();
  }
});

test('每日清理：库正开着事务时整轮跳过，一项失败只记日志、不影响别的项', () => {
  const store = new Store(':memory:');
  try {
    saveRequest(store, record('flow-save', 'fictional-1'), {});
    age(store, 'flow-save', OPERATION_REQUEST_KEEP_DAYS + 1);
    const jobs = [{ name: '过期的防重复提交记录', run: () => purgeOperationRequests(store) }];
    // 助手执行方案时保存点会跨着 await 开着：这时清理不能混进去
    store.db.exec('SAVEPOINT fictional_busy');
    assert.equal(runCleanup(store, jobs), null);
    assert.deepEqual(kinds(store), ['flow-save']);
    store.db.exec('RELEASE fictional_busy');
    const logs: string[] = [];
    const cleaned = runCleanup(
      store,
      [
        {
          name: '坏掉的一项',
          run: () => {
            throw new Error('虚构失败');
          },
        },
        ...jobs,
      ],
      (message) => logs.push(message),
    );
    assert.deepEqual(cleaned, { 过期的防重复提交记录: 1 });
    assert.deepEqual(logs, ['每日清理失败（坏掉的一项）：虚构失败']);
    assert.deepEqual(kinds(store), []);
  } finally {
    store.close();
  }
});

test('每日清理的定时：启动五分钟后第一次，之后满 24 小时才再清；碰上事务的那次不算，下个小时补上；停了就不再跑', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: new Date('2026-11-12T00:00:00Z') });
  const store = new Store(':memory:');
  try {
    let runs = 0;
    const stop = scheduleDailyCleanup(store, [
      {
        name: '虚构清理',
        run: () => {
          runs++;
          return 0;
        },
      },
    ]);
    t.mock.timers.tick(5 * 60_000 - 1);
    assert.equal(runs, 0);
    t.mock.timers.tick(1);
    assert.equal(runs, 1);
    t.mock.timers.tick(23 * 3600_000);
    assert.equal(runs, 1, '不满 24 小时不再清');
    store.db.exec('SAVEPOINT fictional_busy');
    t.mock.timers.tick(3600_000);
    assert.equal(runs, 1, '库正开着事务，跳过');
    store.db.exec('RELEASE fictional_busy');
    t.mock.timers.tick(3600_000);
    assert.equal(runs, 2, '下个小时补上');
    stop();
    t.mock.timers.tick(48 * 3600_000);
    assert.equal(runs, 2);
  } finally {
    store.close();
  }
});

test('每日清理的一项可以带单位：回收空间作为一项能跑，日志写“页”，其余默认写“条”，什么都没清的项不写', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-cleanup-reclaim-'));
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: new Date('2026-11-12T00:00:00Z') });
  const logs: string[] = [];
  t.mock.method(console, 'log', (message: string) => logs.push(message));
  const store = new Store(join(dir, 'fictional.sqlite'));
  try {
    // 造一批空闲页：建表塞满再删掉
    store.db.exec('CREATE TABLE fictional_bulk(id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    const insert = store.db.prepare('INSERT INTO fictional_bulk(body) VALUES(?)');
    store.db.exec('BEGIN');
    for (let i = 0; i < 500; i++) insert.run('虚构内容'.repeat(100));
    store.db.exec('COMMIT');
    store.db.exec('DELETE FROM fictional_bulk');
    const free = pragmaInteger(store.db, 'freelist_count');
    assert.ok(free > 10, '删掉的数据占的页成了空闲页');
    saveRequest(store, record('flow-save', 'fictional-1'), {});
    age(store, 'flow-save', OPERATION_REQUEST_KEEP_DAYS + 1);
    const stop = scheduleDailyCleanup(store, [
      { name: '过期的防重复提交记录', run: () => purgeOperationRequests(store) },
      { name: '虚构的空清理', run: () => 0 },
      { name: '业务库还给磁盘的空间', run: () => store.reclaimSpace(), unit: '页' },
    ]);
    t.mock.timers.tick(5 * 60_000);
    stop();
    assert.deepEqual(logs, ['每日清理：过期的防重复提交记录 1 条，业务库还给磁盘的空间 ' + free + ' 页']);
    assert.equal(pragmaInteger(store.db, 'freelist_count'), 0, '空闲页都还了');
    // 单独跑一轮：回收空间返回的是页数，没有空闲页就是 0，不报错
    assert.deepEqual(runCleanup(store, [{ name: '业务库还给磁盘的空间', run: () => store.reclaimSpace(), unit: '页' }]), {
      业务库还给磁盘的空间: 0,
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('按天的流水号：看不占号，占了才加一，各号段互不影响，事务退回号也退回', () => {
  const store = new Store(':memory:');
  try {
    const rows = () =>
      store.db
        .prepare('SELECT scope,last FROM number_sequences ORDER BY scope')
        .all()
        .map((r) => [String(r.scope), Number(r.last)]);
    assert.equal(peekSequence(store, 'DG-20261112'), 1);
    assert.equal(peekSequence(store, 'DG-20261112'), 1);
    assert.deepEqual(rows(), [], '只看不写库');
    assert.equal(takeSequence(store, 'DG-20261112'), 1);
    assert.equal(takeSequence(store, 'DG-20261112'), 2);
    assert.equal(peekSequence(store, 'DG-20261112'), 3);
    assert.equal(takeSequence(store, 'DG-20261113'), 1, '换一天从 1 开始');
    assert.deepEqual(rows(), [
      ['DG-20261112', 2],
      ['DG-20261113', 1],
    ]);
    store.db.exec('SAVEPOINT fictional_job');
    assert.equal(takeSequence(store, 'DG-20261112'), 3);
    store.db.exec('ROLLBACK TO fictional_job; RELEASE fictional_job');
    assert.equal(peekSequence(store, 'DG-20261112'), 3, '事务退回，号也退回');
  } finally {
    store.close();
  }
});

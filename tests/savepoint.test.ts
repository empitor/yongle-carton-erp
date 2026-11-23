// 写入用的保存点（server/core/storage/savepoint.ts）：办完提交、出错整段回滚再抛、嵌套各管各的，预演不管成败都撤回
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, inSavepoint, rehearse } from '../server/core/index.js';
import { ASYNC_JOB } from '../server/core/storage/savepoint.js';

const setup = () => {
  const store = new Store(':memory:');
  store.db.exec('CREATE TEMP TABLE fictional_rows(name TEXT)');
  const add = (name: string) => store.db.prepare('INSERT INTO fictional_rows(name) VALUES(?)').run(name);
  const names = () =>
    store.db
      .prepare('SELECT name FROM fictional_rows ORDER BY rowid')
      .all()
      .map((r) => String(r.name));
  return { store, add, names };
};

test('保存点办完就提交、返回结果；出错整段回滚，抛出原来的错', () => {
  const { store, add, names } = setup();
  try {
    assert.equal(
      inSavepoint(store.db, () => {
        add('甲');
        return 1;
      }),
      1,
    );
    const failure = new Error('虚构出错');
    assert.throws(
      () =>
        inSavepoint(store.db, () => {
          add('乙');
          throw failure;
        }),
      (e) => e === failure,
    );
    assert.deepEqual(names(), ['甲']);
    assert.equal(store.db.isTransaction, false, '没有外层事务时办完不留开着的事务');
  } finally {
    store.close();
  }
});

test('保存点嵌套：里层出错只撤里层，外层接住后照常提交；外层出错连里层办完的一起撤', () => {
  const { store, add, names } = setup();
  try {
    inSavepoint(store.db, () => {
      add('外层');
      assert.throws(() =>
        inSavepoint(store.db, () => {
          add('里层');
          throw new Error('虚构出错');
        }),
      );
      inSavepoint(store.db, () => add('里层二'));
    });
    assert.deepEqual(names(), ['外层', '里层二']);
    assert.throws(() =>
      inSavepoint(store.db, () => {
        inSavepoint(store.db, () => add('会被撤掉'));
        throw new Error('虚构出错');
      }),
    );
    assert.deepEqual(names(), ['外层', '里层二']);
  } finally {
    store.close();
  }
});

test('传进来的函数返回 Promise：保存点和预演都整段回滚并报“事务里的函数必须是同步的”', async () => {
  const { store, add, names } = setup();
  try {
    for (const run of [inSavepoint, rehearse])
      assert.throws(
        () =>
          run(store.db, async () => {
            add('异步里写的');
          }),
        (e: Error) => e.message === ASYNC_JOB,
      );
    assert.deepEqual(names(), []);
    assert.equal(store.db.isTransaction, false);
    // 返回的不是 Promise、只是普通对象（哪怕带 then 字段但不是函数）照常办
    assert.deepEqual(inSavepoint(store.db, () => (add('同步'), { then: 1 })), { then: 1 });
    assert.deepEqual(names(), ['同步']);
  } finally {
    store.close();
  }
});

test('预演：成了返回结果、出错照样抛，两种都不留改动；嵌在外层保存点里只撤自己这段', () => {
  const { store, add, names } = setup();
  try {
    assert.equal(
      rehearse(store.db, () => {
        add('预演');
        return names().length;
      }),
      1,
    );
    assert.throws(() =>
      rehearse(store.db, () => {
        add('预演出错');
        throw new Error('虚构出错');
      }),
    );
    inSavepoint(store.db, () => {
      add('正式');
      rehearse(store.db, () => add('预演'));
    });
    assert.deepEqual(names(), ['正式']);
  } finally {
    store.close();
  }
});

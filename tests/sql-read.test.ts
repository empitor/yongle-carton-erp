// 读库的小函数（server/core/sql.ts）：查出来的行按结构校验，写错的别名、没写成可空的 LEFT JOIN、库里不合结构的值
// 跑到就抛 StoredDataError（记日志、经出错处理回 500），不当成“用户填错了”。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, mock, test } from 'node:test';
import { z } from 'zod';
import { STORED_DATA_MESSAGE } from '../server/core/errors.js';
import { Store, count, exists, many, one, parseStoredJson, rows } from '../server/core/index.js';
import { StoredDataError } from '../server/core/errors.js';
import { createApp } from '../server/app.js';
import { listen } from './http-fixture.js';

const store = new Store(':memory:');
after(() => store.close());
const db = store.db;
const now = '2026-11-14T00:00:00.000Z';
const addCustomer = db.prepare("INSERT INTO customers(id,name,contact,phone,address,notes,created_at,updated_at) VALUES(?,?,'','','','',?,?)");
addCustomer.run(1, '甲客户', now, now);
addCustomer.run(2, '乙客户', now, now);
db.prepare("INSERT INTO products(id,name,material,flute,requirements,created_at,updated_at) VALUES(?,?,'','','',?,?)").run(7, '五层箱', now, now);

/** 不合结构时会打一行日志：测试里收起来，顺便核对确实打了、写明了哪句 SQL */
function quietly<T>(run: () => T) {
  const logged = mock.method(console, 'error', () => {});
  try {
    return { result: run(), logs: logged.mock.calls.map((call) => String(call.arguments[0])) };
  } finally {
    logged.mock.restore();
  }
}
/** 断言抛的是 StoredDataError，detail 里写着 where，并且打了日志 */
function assertStoredError(run: () => unknown, where: string) {
  const logged = mock.method(console, 'error', () => {});
  try {
    assert.throws(run, (error: unknown) => {
      assert.ok(error instanceof StoredDataError);
      assert.equal(error.status, 500);
      assert.equal(error.message, STORED_DATA_MESSAGE);
      assert.ok(error.detail.includes(where), error.detail);
      return true;
    });
    assert.equal(logged.mock.callCount(), 1, '打了一行日志');
  } finally {
    logged.mock.restore();
  }
}

test('按建表生成的行结构读整行：类型和库里一致，可空列读出 null', () => {
  const product = one(db, rows.products, 'SELECT * FROM products WHERE id=?', 7);
  assert.equal(product?.name, '五层箱');
  assert.equal(product?.price_e4, null);
  assert.equal(product?.version, 1);
});

test('别名用 pick 加 extend 组结构：别名写对了照常读出，写错了抛 StoredDataError', () => {
  const named = rows.customers.pick({ id: true }).extend({ customerName: rows.customers.shape.name });
  assert.deepEqual(one(db, named, 'SELECT id,name AS customerName FROM customers WHERE id=?', 1), { id: 1, customerName: '甲客户' });
  const wrong = 'SELECT id,name AS customer_name FROM customers WHERE id=?';
  assertStoredError(() => one(db, named, wrong, 1), wrong);
});

test('列名写错时 SQLite 直接报错，不会读出空值', () => {
  assert.throws(() => many(db, rows.customers, 'SELECT id,nmae FROM customers'), /no such column/);
});

test('LEFT JOIN 出来的空值：结构没写可空就抛 StoredDataError（写明哪一列），写了可空读出 null', () => {
  const sql = 'SELECT c.id,o.number FROM customers c LEFT JOIN orders o ON o.customer_id=c.id ORDER BY c.id';
  const strict = rows.customers.pick({ id: true }).extend({ number: rows.orders.shape.number });
  assertStoredError(() => many(db, strict, sql), 'number：');
  const loose = rows.customers.pick({ id: true }).extend({ number: rows.orders.shape.number.nullable() });
  assert.deepEqual(many(db, loose, sql), [
    { id: 1, number: null },
    { id: 2, number: null },
  ]);
});

test('查不到：one 返回 undefined、many 返回空数组、exists 是 false、count 是 0', () => {
  assert.equal(one(db, rows.customers, 'SELECT * FROM customers WHERE id=?', 99), undefined);
  assert.deepEqual(many(db, rows.customers, 'SELECT * FROM customers WHERE id>?', 99), []);
  assert.equal(exists(db, 'SELECT 1 FROM customers WHERE id=?', 99), false);
  assert.equal(count(db, 'SELECT count(*) FROM customers WHERE id>?', 99), 0);
});

test('查得到：exists 是 true，count 取第一列的数', () => {
  assert.equal(exists(db, 'SELECT 1 FROM customers WHERE id=?', 2), true);
  assert.equal(count(db, 'SELECT count(*) AS n FROM customers'), 2);
});

test('count 的查询不返回行（SQL 写错成按组数）时报错，不当成 0', () => {
  assert.throws(() => count(db, 'SELECT count(*) FROM customers WHERE id>? GROUP BY id', 99), /count 的查询没有返回行/);
});

test('count 的第一列不是整数时抛 StoredDataError', () => {
  const plain = new DatabaseSync(':memory:');
  try {
    assertStoredError(() => count(plain, "SELECT 'many'"), "SELECT 'many'");
  } finally {
    plain.close();
  }
});

test('自己写的结构也能用：读出来的是 parse 之后的值，合结构时不打日志', () => {
  const schema = z.object({ total: z.number().transform((cents) => cents / 100) });
  const { result, logs } = quietly(() => one(db, schema, 'SELECT 250 AS total'));
  assert.deepEqual(result, { total: 2.5 });
  assert.deepEqual(logs, []);
});

test('JSON 列：形状不对、根本不是 JSON 都抛 StoredDataError，写明是哪一列', () => {
  const schema = z.array(z.string());
  assert.deepEqual(parseStoredJson(schema, '["a"]', 'users.permissions'), ['a']);
  assertStoredError(() => parseStoredJson(schema, '{"a":1}', 'users.permissions'), 'users.permissions');
  assertStoredError(() => parseStoredJson(schema, '{坏的', 'users.permissions'), 'users.permissions');
});

test('库里的数据不合结构时，接口经出错处理回 500 和给人看的话，不是 400 的“输入不对”', async () => {
  const bad = new Store(':memory:');
  const server = await listen(createApp(bad));
  const logged = mock.method(console, 'error', () => {});
  try {
    bad.db.prepare("INSERT INTO customers(id,name,contact,phone,address,notes,created_at,updated_at) VALUES(1,'甲客户','','','','',?,?)").run(now, now);
    // 成本估算写成别的形状（正常保存写不进来，只模拟数据被改坏）
    bad.db
      .prepare(
        "INSERT INTO orders(id,number,customer_id,customer_name,order_date,delivery_date,status,total_cents,notes,cost_estimate,created_at,updated_at) VALUES(1,'ZX-1',1,'甲客户','2026-11-14','2026-11-20','已确认',0,'','{\"material\":\"很多\"}',?,?)",
      )
      .run(now, now);
    const response = await fetch(server.api + '/orders/1');
    assert.equal(response.status, 500);
    const body: unknown = await response.json();
    assert.deepEqual(body, { message: STORED_DATA_MESSAGE, code: 'stored-data' });
    assert.ok(logged.mock.calls.some((call) => String(call.arguments[0]).includes('orders.cost_estimate')), '日志写明了哪一列');
  } finally {
    logged.mock.restore();
    await server.close();
    bad.close();
  }
});

import { Store, defaultDbPath } from './db.js';
import { acquireLock } from './lock.js';
import { specification, today } from '../shared/domain.js';
const unlock = acquireLock(defaultDbPath);
const store = new Store();
try {
  if (store.customers().length || store.products().length || store.orders().length)
    throw new Error('数据库已有数据，未导入示例。示例只允许导入空库。');
  store.db.exec('BEGIN IMMEDIATE');
  const a = store.saveCustomer({
    name: '示例客户 · 海岸电器',
    contact: '示例联系人甲',
    phone: '',
    address: '示例地址：宁波市（虚构）',
    notes: '演示数据，不代表真实客户',
  });
  const b = store.saveCustomer({
    name: '示例客户 · 山禾食品',
    contact: '示例联系人乙',
    phone: '',
    address: '示例地址：宁波市（虚构）',
    notes: '演示数据，不代表真实客户',
  });
  const c = store.saveCustomer({
    name: '示例客户 · 远帆文具',
    contact: '示例联系人丙',
    phone: '',
    address: '示例地址：宁波市（虚构）',
    notes: '演示数据，不代表真实客户',
  });
  const p = store.saveProduct({
    dimensionUnit: 'mm',
    name: '示例 · 五层运输箱',
    length: 450,
    width: 320,
    height: 280,
    material: '示例配纸：牛卡 / 瓦纸',
    flute: 'BC 楞',
    requirements: '双色印刷，开槽，钉箱',
    priceCents: 680,
  });
  const q = store.saveProduct({
    dimensionUnit: 'mm',
    name: '示例 · 三层包装箱',
    length: 300,
    width: 220,
    height: 180,
    material: '示例配纸：牛卡 / 瓦纸',
    flute: 'B 楞',
    requirements: '单色印刷，粘箱',
    priceCents: 320,
  });
  const r = store.saveProduct({
    dimensionUnit: 'mm',
    name: '示例 · 小型飞机盒',
    length: 210,
    width: 150,
    height: 60,
    material: '示例配纸：白面纸 / 瓦纸',
    flute: 'E 楞',
    requirements: '模切，折叠成型',
    priceCents: 185,
  });
  const date = (delta: number) => {
    const d = new Date(today() + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  };
  const data = [
    { c: a, p, n: 2400, s: '生产中', d: 3 },
    { c: b, p: q, n: 5000, s: '已确认', d: 6 },
    { c: c, p: r, n: 3600, s: '待发货', d: -1 },
    { c: a, p: q, n: 1800, s: '已发货', d: -2 },
    { c: b, p: r, n: 2000, s: '草稿', d: 8 },
    { c: c, p, n: 1200, s: '已确认', d: 5 },
  ] as const;
  for (const [i, x] of data.entries())
    store.saveOrder({
      customerId: x.c.id,
      orderDate: date(-8 + i),
      deliveryDate: date(x.d),
      status: x.s,
      notes: '虚构示例订单，用于开发验收',
      lines: [
        {
          productId: x.p.id,
          specification: specification(x.p),
          quantity: x.n,
          unitPriceCents: x.p.priceCents,
        },
      ],
      costs:
        i === 1 || i === 4
          ? null
          : {
              material: Math.round(x.n * x.p.priceCents * 0.54),
              processing: Math.round(x.n * x.p.priceCents * 0.12),
              waste: Math.round(x.n * x.p.priceCents * 0.03),
              other: 12000,
              basis: '虚构人工估算，仅演示字段；不是工厂计价公式',
            },
    });
  store.db.exec('COMMIT');
  console.log('已导入 3 个虚构客户、3 个示例产品、6 张示例订单。');
} catch (error) {
  if (store.db.isTransaction) store.db.exec('ROLLBACK');
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  store.close();
  unlock();
}

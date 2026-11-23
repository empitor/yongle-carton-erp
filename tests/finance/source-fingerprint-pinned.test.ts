// 财务来源指纹的底数不许变：库里每条财务事件都存着当时算的指纹（fin_events.source_hash），指纹的算法、算进去的栏目、
// 栏目的财务口径名字、键的顺序变了，已有的事件就会全部被当成“来源改过”。这里用几张固定的虚构单据（tests/finance-source-fixture.ts）
// 走正式的读法：把单据原文交给窗口的 sources.read（按库里的单据结构解析、补默认值，再按约定取出算进指纹的内容），
// 财务按它算 sha256（sourceHash），和写死的比。纯函数、虚构数据。走正式读法，底数和 0.9.0 的算法一致。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceHash } from '../../server/finance/events/source-fingerprint.js';
import { financeFacts } from '../../server/flow/index.js';
import {
  arrivalFull,
  arrivalMinimal,
  deliveryFull,
  deliveryMinimal,
  productionFull,
  productionMinimal,
  stockFull,
  stockMinimal,
} from './finance-source-fixture.js';

/** 每张虚构单据：种类、状态、单据日期、内容，和写死的指纹 */
const pinned = [
  ['送货·只有必填项', 'delivery', 'confirmed', '2026-03-05', deliveryMinimal, '7f7ff6ecd5e1e8bd2fae6aef265cb35ef5602896fd9fdf1f2d77f59e6eb4c885'],
  ['送货·全填', 'delivery', 'reversed', '2026-03-05', deliveryFull, '048c9c2012152b4c2b991db6b25103ac470a56ec2212ef0e43ab45395e42c9fd'],
  ['到货·只有必填项', 'arrival', 'confirmed', '2026-03-02', arrivalMinimal, 'ec02f095b00df6e00a8af826905c3dbd73f56378a994c757504a28dffd013a78'],
  ['到货·全填', 'arrival', 'confirmed', '2026-03-02', arrivalFull, '78bcd081978bed28f2f76c6ab0fc8ba5cab53f2d31b7fd3af2c99c12e19c3bef'],
  ['完工·只有必填项', 'production', 'confirmed', '2026-03-03', productionMinimal, '2ff14005b9ab9cbfd2537cf642ecd735eb027893e38c6deeda2cfa5bb009f55d'],
  ['完工·全填', 'production', 'reversed', '2026-03-03', productionFull, 'f4bc55cdc68feab963827ee6d8559b05a171a10dfe63c117beb85bb3b4c41d46'],
  ['盘点流水·只有必填项', 'stock', 'confirmed', '2026-03-09', stockMinimal, 'e07a641a1c7392d2dfc96a72ec55b251f66164d6127c7d2f8bd4d6aab3412c34'],
  ['盘点流水·全填', 'stock', 'confirmed', '2026-03-09', stockFull, '388b6926748048365faf07a29aa0f869051b5e2ff21e1528a0fc2fcd89e8cdd2'],
] as const;

test('固定的虚构单据算出的财务来源指纹和写死的一样（库里已有的指纹不变）', () => {
  const hashes = (pick: (row: (typeof pinned)[number]) => string) => Object.fromEntries(pinned.map((row) => [row[0], pick(row)]));
  assert.deepEqual(
    hashes(([, kind, status, date, doc]) => {
      const text = JSON.stringify(doc);
      return sourceHash({ status, date }, financeFacts.sources.read({ kind, id: '1', version: 1, status, date, number: null, at: date, text }).counted);
    }),
    hashes((row) => row[5]),
  );
});

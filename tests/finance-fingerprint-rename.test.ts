// 来源指纹按财务口径算（shared/business/finance-source.ts 的 fingerprintRules）：业务把一个归“算”的栏目改了名，
// 改名表的键跟着改、财务口径的名字不动，同一张单据的指纹和改名前一样；改名表没跟上或者对错了名字，指纹就变（真的会拦）。
// 四种来源各改几个（含明细、纸板资料、领料里的栏目，和这几个外层栏目本身）；样张先走正式的读法（storedContent）。纯函数、虚构数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceHash } from '../server/finance/events/source-fingerprint.js';
import { fingerprintOf, fingerprintRules } from '../shared/business/finance-source.js';
import { isRecord } from '../shared/core/index.js';
import {
  arrivalFull,
  arrivalMinimal,
  deliveryFull,
  deliveryMinimal,
  productionFull,
  productionMinimal,
  stockFull,
  stockMinimal,
  storedContent,
} from './finance-source-fixture.js';

type Layer = Parameters<typeof fingerprintOf>[0];
const source = { status: 'confirmed', date: '2026-03-05' };
const hash = (layer: Layer, content: unknown) => sourceHash(source, fingerprintOf(layer, content));

/** 改名表里 path 那个栏目的键换成 renamed（一层层往下找），对应的财务口径名字换成 finance（不给就不动） */
function renamedRule(layer: Layer, [key, ...rest]: readonly string[], renamed: string, finance?: string): Layer {
  const inner = layer.nested?.[key];
  if (rest.length) {
    if (!inner) throw new Error('测试数据：改名表里没有 ' + key + ' 这一层');
    return { ...layer, nested: { ...layer.nested, [key]: renamedRule(inner, rest, renamed, finance) } };
  }
  const { [key]: name, ...names } = layer.names;
  const { [key]: _old, ...others } = layer.nested ?? {};
  return { names: { ...names, [renamed]: finance ?? name }, nested: inner ? { ...others, [renamed]: inner } : others };
}

/** 单据内容里 path 那个栏目的键换成 renamed（一组的每一行都换），返回改过的副本 */
function renamedContent(content: unknown, [key, ...rest]: readonly string[], renamed: string): unknown {
  if (Array.isArray(content)) return content.map((row: unknown) => renamedContent(row, [key, ...rest], renamed));
  if (!isRecord(content) || !(key in content)) return content;
  const { [key]: value, ...others } = content;
  return rest.length ? { ...others, [key]: renamedContent(value, rest, renamed) } : { ...others, [renamed]: value };
}

/** 每种来源改哪个栏目（含一组明细、纸板资料、领料这种外层栏目）、改成什么名，用哪两张单据（先走正式读法） */
const cases = [
  { kind: 'delivery', path: ['customerId'], renamed: 'clientId', samples: [deliveryMinimal, deliveryFull] },
  { kind: 'delivery', path: ['lines', 'quantity'], renamed: 'shippedQuantity', samples: [deliveryMinimal, deliveryFull] },
  { kind: 'delivery', path: ['lines'], renamed: 'rows', samples: [deliveryMinimal, deliveryFull] },
  { kind: 'arrival', path: ['lines', 'item', 'name'], renamed: 'boardName', samples: [arrivalMinimal, arrivalFull] },
  { kind: 'arrival', path: ['lines', 'item'], renamed: 'board', samples: [arrivalMinimal, arrivalFull] },
  { kind: 'production', path: ['materials', 'issued'], renamed: 'issuedQuantity', samples: [productionMinimal, productionFull] },
  { kind: 'production', path: ['materials'], renamed: 'issues', samples: [productionMinimal, productionFull] },
  { kind: 'stock', path: ['deltaUnits'], renamed: 'delta', samples: [stockMinimal, stockFull] },
] as const;

// 只守“按改名表换名”这个机制：在解析好的内容上手工换键、同时改改名表，不经过业务结构和正式读法。
// 业务真改了栏目名时，守住指纹不变的是改名表的编译期键约束和 source-fingerprint-pinned 写死的底数。
test('按改名表换名：内容里一个归“算”的栏目（含外层栏目）换了名、改名表跟着换，指纹和换名前一样（四种来源）', () => {
  for (const { kind, path, renamed, samples } of cases)
    for (const sample of samples) {
      const rules = fingerprintRules[kind],
        stored = storedContent(kind, sample),
        content = renamedContent(stored, path, renamed);
      assert.ok(JSON.stringify(content).includes('"' + renamed + '"'), kind + ' 测试数据里有 ' + path.join('.'));
      assert.equal(hash(renamedRule(rules, path, renamed), content), hash(rules, stored), kind + ' 改名 ' + path.join('.') + ' → ' + renamed);
    }
});

test('改名表没跟上、或者对错了财务口径的名字：指纹就变（上一条真的守得住）', () => {
  for (const { kind, path, renamed, samples } of cases) {
    const rules = fingerprintRules[kind],
      stored = storedContent(kind, samples[1]),
      content = renamedContent(stored, path, renamed);
    assert.notEqual(hash(rules, content), hash(rules, stored), kind + ' 改名表没改：这个栏目掉出了指纹');
    assert.notEqual(hash(renamedRule(rules, path, renamed, '虚构的错名字'), content), hash(rules, stored), kind + ' 对错了名字');
  }
  // 外层栏目只改了改名表、没改往下的层：整组明细原样算进去（备注、规格这些不算的也进了指纹），指纹就变
  const stored = storedContent('delivery', deliveryFull),
    renamedNames = renamedRule(fingerprintRules.delivery, ['lines'], 'rows').names;
  assert.notEqual(hash({ names: renamedNames, nested: fingerprintRules.delivery.nested }, renamedContent(stored, ['lines'], 'rows')), hash(fingerprintRules.delivery, stored));
});

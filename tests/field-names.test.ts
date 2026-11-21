// 栏目叫法只有一套（shared/core/field-names.ts 的栏目登记表，docs/界面规范.md“栏目叫法”）：
// 1. 统一叫法时退掉的旧说法不许再出现在给人看的文字里（服务端、共用、页面的字符串和 JSX 文字），免得改回去；
// 2. “哪个栏目指向哪张表”登记的都是库里真有的表。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { all, scriptKind } from './module-map.js';
import { rows } from '../server/core/schema/rows.js';
import { fieldName, fieldTables } from '../shared/core/index.js';

/** 退掉的旧说法 → 现在的叫法。文字里出现这段就算（这些说法不会是别的词的一部分） */
const retired: Record<string, string> = {
  订单日期: '下单日期',
  客户采购订单号: '客户采购单号',
  外部采购单号: '客户采购单号',
  客户采购号: '客户采购单号',
  客户物料编码: '客户料号',
  材质配纸: '材质 / 配纸',
  '材质／配纸': '材质 / 配纸',
  规格说明: '规格',
  规格型号: '规格',
  联系电话: '联系方式',
  '含税／未税': '含税口径',
  含税情况: '含税口径',
  结算规则: '金额结算',
  供应方名称: '供应方',
  不合格: '拒收',
  实际入库: '入库数量（窄处“入库”）',
  单据数量: '标注张数',
  单据面积: '标注面积',
  原文面积: '标注面积',
  差异说明: '差异原因',
  '送货单号 / 批次': '供应商送货单号',
  来源原件: '送货单原件',
  关联客户订单: '关联订单',
  附属于产品: '附属于',
  实际操作人员: '机台操作',
  实际合格数量: '合格数量',
  超发原因: '超订单原因',
  超订单发货原因: '超订单原因',
  单价及计价单位: '单价',
  订购: '订货',
  '标注面积（平方米）': '标注面积（m²）',
  已确认收货: '已入库',
  已确认完工: '已入库',
  实际送货日期: '送货日期',
  预计送货日期: '计划送货日期',
  实际到货日期: '到货日期',
  实际到货时间: '到货时间',
};
/** 写法上的旧说法：金额单位写“（元）”，税率写“（%）”，标记已订货要说清是待到货 */
const retiredPatterns: [RegExp, string][] = [
  [/(单价|金额|成本|价格) \/ 元/, '单价（元）这种写法'],
  [/率 ?%/, '税率（%）这种写法'],
  [/标记为已订货(?!（待到货）)/, '标记为已订货（待到货）'],
];
/** 只有整段文字等于它才算（这些字会是别的词的一部分：长度上限、货币资金） */
const retiredWhole: Record<string, string> = {
  长度: '长',
  宽度: '宽',
  高度: '高',
  货币: '币种',
  电话: '联系方式',
  实际发货: '送货日期',
  实际到货: '到货日期',
  计划送货: '计划送货日期（窄处“计划送货”，从登记表的简写取）',
};
/**
 * 旧说法照样留着的地方和原因。键是“文件:旧说法”。
 */
const allowed: Record<string, string> = {
  'shared/documents/document-templates.ts:客户采购订单号':
    '模板“隐藏字段”里存的值（document_template_settings 里存着，改字要升级数据）；印出来换成登记表的叫法（document-layout.ts 的 printedInfoName）',
  'shared/documents/document-layout.ts:客户采购订单号': '同上：信息格的键，printedInfoName 在这里把它换成印出来的字',
  'server/documents/delivery-form.ts:客户采购订单号': '同上：送货单信息格的键',
  'server/documents/sample.ts:客户采购订单号': '同上：样张信息格的键',
  'server/flow/arrivals.ts:不合格': '“含不合格品”是到货单的验收结果（全部合格 / 含不合格品），不是数量栏目的名字',
  'shared/business/flow-views.ts:不合格': '同上：验收结果的取值',
  'src/finance/parties/StatementTab.tsx:差异说明': '对账单上和客户账对不上的说明，是财务自己的栏目，不是到货的差异原因',
  'server/core/schema/tables/operations.ts:规格说明': '建表语句里的注释（表结构不在这一轮改，发布后要走升级步骤）',
};

/** 一个文件里给人看的文字：字符串、模板字符串的各段、JSX 文字 */
function textsOf(f: string): string[] {
  const source = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, scriptKind(f));
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n) || ts.isJsxText(n)) out.push(n.text.trim());
    else if (ts.isTemplateExpression(n)) out.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    ts.forEachChild(n, visit);
  };
  visit(source);
  return out;
}

/** 文字里出现的旧说法：[旧说法, 现在的叫法] */
function retiredIn(text: string): [string, string][] {
  return [
    ...Object.entries(retired).filter(([old]) => text.includes(old)),
    ...retiredPatterns.filter(([re]) => re.test(text)).map(([re, now]): [string, string] => [re.source, now]),
    ...(Object.hasOwn(retiredWhole, text) ? [[text, retiredWhole[text]] as [string, string]] : []),
  ];
}

const registry = 'shared/core/field-names.ts';
/** 整个文件里连一段旧说法都没有的不用解析（只为快：解析全部文件要一秒多） */
const mayHaveRetired = (f: string) => {
  const raw = readFileSync(f, 'utf8');
  return [...Object.keys(retired), ...Object.keys(retiredWhole)].some((w) => raw.includes(w)) || retiredPatterns.some(([re]) => re.test(raw));
};

test('退掉的旧叫法不再出现在给人看的文字里（栏目叫法只从栏目登记表来）', () => {
  const found = all
    .filter((f) => f !== registry && mayHaveRetired(f))
    .flatMap((f) =>
      textsOf(f).flatMap((text) =>
        retiredIn(text)
          .filter(([old]) => !Object.hasOwn(allowed, f + ':' + old))
          .map(([old, now]) => f + '：“' + old + '”改成“' + now + '”'),
      ),
    );
  assert.deepEqual([...new Set(found)], [], '照 shared/core/field-names.ts 的叫法改；确实要留的在本测试 allowed 写明原因');
});

test('旧叫法的检查真的会拦：整段、片段、写法都认得出，正常的词放过', () => {
  assert.deepEqual(retiredIn('下单日期'), []);
  assert.deepEqual(retiredIn('请填写实际操作人员'), [['实际操作人员', '机台操作']]);
  assert.deepEqual(retiredIn('金额 / 元').map(([, now]) => now), ['单价（元）这种写法']);
  assert.deepEqual(retiredIn('长度'), [['长度', '长']]);
  assert.deepEqual(retiredIn('长度上限'), []);
  assert.deepEqual(retiredIn('标记为已订货（待到货）'), []);
});

test('登记的旧说法例外都还用得着（文件还在、旧说法还在那个文件里）', () => {
  const stale = Object.keys(allowed).filter((key) => {
    const [file, old] = key.split(':');
    return !all.includes(file) || !textsOf(file).some((t) => t.includes(old));
  });
  assert.deepEqual(stale, [], '从本测试 allowed 删掉这几条');
});

test('“哪个栏目指向哪张表”登记的都是库里真有的表，栏目都有叫法', () => {
  const tables = new Set(Object.keys(rows));
  assert.deepEqual(
    Object.values(fieldTables).filter((t) => !tables.has(t)),
    [],
    'shared/core/field-names.ts 的 fieldTables 写的表名在建表结构（server/core/schema/rows.ts）里查不到',
  );
  assert.deepEqual(
    Object.keys(fieldTables).filter((k) => !fieldName(k)),
    [],
    '指向表的栏目在栏目登记表里没有叫法',
  );
});

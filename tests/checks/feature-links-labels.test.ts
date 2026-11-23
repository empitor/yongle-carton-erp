/**
 * 一件事一条链路（AGENTS.md）的自动检查之四：按钮文字。带动作词的按钮应当是某条业务动作
 * （shared/assistant/ui-actions.ts）登记的叫法，或在下面的通用白名单里；带数量的按开头比（“安排送货（3 张）”算“安排送货”）。
 * 对不上的列出来并失败（直接跑 node --import tsx tests/checks/feature-links-labels.test.ts 看清单）。
 * 取字的范围见 tests/checks/feature-links-scan.ts 的 buttonTexts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uiActions } from '../../shared/assistant/ui-actions.js';
import { buttonTexts } from './feature-links-scan.js';

const actionWords = /登记|安排|撤销|取消|归档|恢复|删除|更正|核对|确认|导出|作废|冲销|停用|编辑/;
/** 不对应某一条业务动作的通用按钮：关窗、保存、关闭这类，写明为什么 */
const commonLabels: Record<string, string> = {
  取消: '关窗、不办了',
  不取消: '“取消这次××”确认窗里不办了',
  保存: '编辑窗的提交',
  关闭: '关窗',
  取消选择: '清掉勾选',
  保存并确认: '订单编辑窗的提交（保存时把订单定成已确认），和“保存”同一个写入',
  返回导出: '导出预览里回到导出选项，不写',
  恢复窗口大小: '助手窗口的大小，不写',
  恢复默认: '模板编辑里把明细字段改回默认，保存才生效',
  删除条目: '提示词编辑里删掉一条，保存才生效',
  历史与归档: '打开识别工作区的历史窗口，不写',
  取消限定: '流水列表清掉“只看这个库存品”的筛选',
  去更正原单据: '从流水跳到原单据，更正在那里做',
  登记完工的其他做法: '“更多”菜单的说明文字，不是按钮',
  核对: '今日待办里跳到 AI 导入那份工作区的链接',
  // 状态字（列表、卡片上显示的，不是按钮）
  待核对入库: '识别出的到货单的状态',
  原订单已删除: '识别导入记录的状态',
  // 词表里的短词：拼进按钮、标题、提示用的，按钮上显示的是拼好的全称（撤销这次送货、更正到货单）
  撤销: '词表 undoLabel 的兜底叫法',
  更正: '词表 correctLabel 的前缀',
  送货安排: '保存送货安排后的提示文字，不是按钮',
  // 财务页面上只读的导出、下载（回 Excel 或 zip，不写库）
  导出台账: '月度台账导出 Excel，只读',
  导出对账单: '对账单导出 Excel，只读',
  导出税务底稿: '发票页导出税务底稿，只读',
  导出本月经营报表: '财务概览导出经营报表，只读',
  下载归档文件: '结账页下载已归档的报表文件，只读',
  // 财务页面上的字段名、状态（不是按钮）
  冲销的是: '凭证详情里指向被冲销凭证的字段名',
  本月已确认: '压款利息详情里的字段名（本月已确认的利息）',
  收入确认: '财务设置里的字段名（收入确认口径）',
};
/** 不是按钮的字：状态（已××）、进行中（正在××…）、字段名（××原因、××日期） */
const notButton = (t: string) => /^(已|正在)|…$|(原因|日期|时间|格式|记录)$/.test(t);

const labels = uiActions.flatMap((a) => a.labels);
/** 一样，或者是这个叫法后面跟着数量（“安排送货（3 张）”“恢复（2）”） */
const matches = (t: string) => labels.some((l) => t === l || (t.startsWith(l) && /^[（(\s\d]/.test(t.slice(l.length))));

test('按钮文字：带动作词的按钮是登记的动作叫法或通用按钮', () => {
  const loose = new Map<string, string[]>();
  for (const b of buttonTexts()) {
    if (!actionWords.test(b.text) || notButton(b.text) || commonLabels[b.text] || matches(b.text)) continue;
    loose.set(b.text, [...(loose.get(b.text) ?? []), b.file + ':' + b.line]);
  }
  const lines = [...loose].sort(([a], [b]) => a.localeCompare(b, 'zh')).map(([text, at]) => text + '：' + at.join('、'));
  if (lines.length) console.log('按钮文字对不上登记的动作叫法（' + lines.length + ' 种）：\n' + lines.join('\n'));
  assert.deepEqual(lines, []);
});

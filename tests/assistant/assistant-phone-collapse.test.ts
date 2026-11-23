// 手机上全屏的助手带人去别的页时收起（src/assistant/useAssistantPanel.ts 的 collapsesOnNavigate）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapsesOnNavigate } from '../../src/assistant/useAssistantPanel.js';

const phoneOpen = { open: true, phone: true };
/** 点到的元素：在不在助手的站内链接里 */
const inLink = { closest: () => ({}) },
  elsewhere = { closest: () => null };

test('手机上助手开着时地址变了就收起', () => {
  assert.equal(collapsesOnNavigate(phoneOpen, { type: 'hashchange', target: null }), true);
});

test('手机上点了助手里的站内链接也收起（地址和现在一样、不会变的时候也是）', () => {
  assert.equal(collapsesOnNavigate(phoneOpen, { type: 'click', target: inLink }), true);
});

test('手机上点了别处、地址没变时不收起', () => {
  assert.equal(collapsesOnNavigate(phoneOpen, { type: 'click', target: elsewhere }), false);
  assert.equal(collapsesOnNavigate(phoneOpen, { type: 'click', target: null }), false);
});

test('电脑宽度不收起，助手没开着时也不管', () => {
  const desktop = { open: true, phone: false },
    closed = { open: false, phone: true };
  for (const panel of [desktop, closed]) {
    assert.equal(collapsesOnNavigate(panel, { type: 'hashchange', target: null }), false);
    assert.equal(collapsesOnNavigate(panel, { type: 'click', target: inLink }), false);
  }
});

// 小甬和小勒：只做静态检查，动画在 scripts/ui-check/flow-spirits.mjs 里用真实浏览器看。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import YlSpirits, { SpeakerAvatar } from '../src/YlSpirits.js';

const css = readFileSync('src/yl-spirits.css', 'utf8');
const source = readFileSync('src/YlSpirits.tsx', 'utf8');

test('两个精灵都画出来，纸箱和代表 AI 的小星也在', () => {
  const html = renderToStaticMarkup(createElement(YlSpirits));
  for (const part of ['yl-y-body', 'yl-l-stem', 'yl-foot-board', 'yl-box', 'yl-star'])
    assert.ok(html.includes(part), part);
  assert.equal((html.match(/class="yl-pupil"/g) || []).length, 4, '两个精灵各两只眼睛');
  assert.match(html, /aria-hidden="true"/);
});

test('状态写到属性上，样式才接得上', () => {
  const free = renderToStaticMarkup(createElement(YlSpirits));
  assert.match(free, /data-pose="free"/);
  assert.doesNotMatch(free, /data-busy|data-still|data-scene|data-compact|data-speak/);
  const speaking = renderToStaticMarkup(createElement(YlSpirits, { speaker: 'le', speakTick: 3 }));
  assert.match(speaking, /data-speaker="le"/);
  assert.match(speaking, /data-speak="le-1"/);
  assert.match(renderToStaticMarkup(createElement(YlSpirits, { compact: true })), /data-compact="1"/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(YlSpirits, { compact: true })), /data-fresh/);
  assert.match(renderToStaticMarkup(createElement(YlSpirits, { busy: true })), /data-busy="1"/);
  assert.match(renderToStaticMarkup(createElement(YlSpirits, { still: true })), /data-still="1"/);
  assert.match(
    renderToStaticMarkup(createElement(YlSpirits, { pose: 'dock-left' })),
    /data-pose="dock-left"/,
  );
});

test('每段小剧场的时长和样式一致，结束时状态能及时清掉', () => {
  const block = /const scenes = \{([\s\S]*?)\} as const/.exec(source)![1];
  const scenes = [...block.matchAll(/(\w+): (\d+),/g)].map((m) => [m[1], Number(m[2])] as const);
  assert.equal(scenes.length, 6);
  for (const [name, ms] of scenes) {
    const rules = [
      ...css.matchAll(new RegExp(`data-scene='${name}'\\] [^{]+\\{\\s*animation: \\S+ ([\\d.]+)s[^;]*?( \\d+)? both;`, 'g')),
    ];
    assert.ok(rules.length, name + ' 没有动画');
    const longest = Math.max(...rules.map((m) => Number(m[1]) * 1000 * Number(m[2] || 1)));
    assert.equal(longest, ms, name + ' 的时长对不上');
  }
});

test('减少动效和小图标都不播放动画；颜色跟主题走', () => {
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.yl-duo,\s*\.yl-duo \* \{\s*animation: none !important/);
  assert.match(css, /\.yl-duo\[data-still\] \*/);
  assert.match(source, /reducedMotion\(\)/);
  for (const color of ['--teal', '--kraft', '--kraft-deep']) assert.ok(css.includes(`var(${color})`), color);
  assert.match(css, /\[data-theme='dark'\] \.yl-duo/);
});

test('贴边：只留头和脸，身子、脚、纸箱、小星都收起来，贴左边整组翻转', () => {
  assert.match(css, /data-pose='dock-left'\] \{\s*transform: scaleX\(-1\)/);
  assert.match(css, /data-pose\^='dock-'\] \.yl-box,\s*\.yl-duo\[data-pose\^='dock-'\] \.yl-foot-board,\s*\.yl-duo\[data-pose\^='dock-'\] \.yl-star \{\s*opacity: 0/);
  for (const rule of ["data-arrive='dock'", "data-arrive='free'", 'yl-slip', 'yl-pop', 'yl-box-land'])
    assert.ok(css.includes(rule), rule);
});

test('头像只画对应的那个人', () => {
  const y = renderToStaticMarkup(createElement(SpeakerAvatar, { speaker: 'yong' }));
  const l = renderToStaticMarkup(createElement(SpeakerAvatar, { speaker: 'le' }));
  assert.match(y, /var\(--teal\)/);
  assert.doesNotMatch(y, /--kraft/);
  assert.match(l, /var\(--kraft\)/);
  assert.doesNotMatch(l, /--teal/);
});

test('紫色只用在代表 AI 的小星上', () => {
  const purple = [...css.matchAll(/([^{}]+)\{[^{}]*#(7c3aed|a78bfa)[^{}]*\}/g)].map((m) => m[1].trim());
  assert.deepEqual(purple, ['.yl-star path', '.yl-star circle']);
});

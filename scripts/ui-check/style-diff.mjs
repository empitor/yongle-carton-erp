// 样式比对的“比较”部分（style-compare.mjs 用）：逐元素比计算后样式、逐像素比截图、
// 两遍基线之间的抖动、从没命中的规则对回 src/ 下的 .css 文件和行号、Chrome 覆盖率，写出对比结果。
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const { loadImage, createCanvas } = require('@napi-rs/canvas');
async function pixels(file) {
  const img = await loadImage(readFileSync(file));
  const c = createCanvas(img.width, img.height);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, d: g.getImageData(0, 0, img.width, img.height).data };
}
/** 两张图逐像素比：某个通道差超过 8 算不同；mask 里标了的像素、rects 里的方框跳过。
 *  返回不同的像素和它们所在的范围 */
async function pixelDiff(a, b, mask, diffPng, rects = []) {
  const A = await pixels(a),
    B = await pixels(b);
  if (A.w !== B.w || A.h !== B.h)
    return { size: `${A.w}×${A.h} → ${B.w}×${B.h}`, changed: null, map: null };
  if (rects.length) {
    mask = mask ? Uint8Array.from(mask) : new Uint8Array(A.w * A.h);
    for (const [x, y, w, h] of rects)
      for (let yy = Math.max(0, Math.floor(y) - 2); yy < Math.min(A.h, Math.ceil(y + h) + 2); yy++)
        mask.fill(
          1,
          yy * A.w + Math.max(0, Math.floor(x) - 2),
          yy * A.w + Math.min(A.w, Math.ceil(x + w) + 2),
        );
  }
  const map = new Uint8Array(A.w * A.h);
  let changed = 0;
  for (let i = 0; i < map.length; i++) {
    if (mask && mask[i]) continue;
    const o = i * 4;
    if (
      Math.abs(A.d[o] - B.d[o]) > 8 ||
      Math.abs(A.d[o + 1] - B.d[o + 1]) > 8 ||
      Math.abs(A.d[o + 2] - B.d[o + 2]) > 8
    ) {
      map[i] = 1;
      changed++;
    }
  }
  if (changed && diffPng) {
    const c = createCanvas(A.w, A.h);
    const g = c.getContext('2d');
    const img = g.createImageData(A.w, A.h);
    for (let i = 0; i < map.length; i++) {
      const o = i * 4;
      const grey = (B.d[o] + B.d[o + 1] + B.d[o + 2]) / 3;
      img.data[o] = map[i] ? 255 : grey * 0.4 + 150;
      img.data[o + 1] = map[i] ? 0 : grey * 0.4 + 150;
      img.data[o + 2] = map[i] ? 0 : grey * 0.4 + 150;
      img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    writeFileSync(diffPng, c.toBuffer('image/png'));
  }
  return { size: null, changed, total: map.length, map, w: A.w };
}
/** 把 (x, y) 周围 r 格内的像素都标上 */
const markAround = (out, { w, h, x, y, r }) => {
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const yy = y + dy,
        xx = x + dx;
      if (yy >= 0 && yy < h && xx >= 0 && xx < w) out[yy * w + xx] = 1;
    }
};
const dilate = (map, w, r = 2) => {
  const h = map.length / w,
    out = new Uint8Array(map.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (map[y * w + x]) markAround(out, { w, h, x, y, r });
  return out;
};

/** 文字变了的元素（“12 分钟前”这类）在截图上的方框：整页截图按整页坐标，只截窗口的减掉滚动距离 */
function textRects(A, paths) {
  const [vx, vy] = A.view || [0, 0];
  return paths
    .map((p) => A.map.get(p))
    .filter((e) => e && e.g)
    .map((e) => (A.fullPage || e.f ? e.g : [e.g[0] - vx, e.g[1] - vy, e.g[2], e.g[3]]));
}
const load = (f) => {
  const j = JSON.parse(readFileSync(f, 'utf8'));
  const m = new Map();
  for (const e of j.els) m.set(e.p, e);
  return { ...j, map: m };
};
const missingLine = (p, a) => '少了 ' + p + (a.c ? ' .' + a.c.split(' ').join('.') : '');
const moved = (a, b) => !!(a.g && b.g && a.g.some((v, i) => Math.abs(v - b.g[i]) > 0.5));
/** 一个元素前后两份计算后样式（含 ::before、::after）不同的属性：[属性, 原来, 现在] */
function propChanges(A, B, a, b, sk) {
  const sa = A.styles[a.s],
    sb = B.styles[b.s];
  const props = [];
  for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)]))
    if (sa[k] !== sb[k] && !sk.has(k)) props.push([k, sa[k] ?? '（无）', sb[k] ?? '（无）']);
  for (const ps of ['b', 'a']) {
    const pa = a[ps] === undefined ? null : A.styles[a[ps]],
      pb = b[ps] === undefined ? null : B.styles[b[ps]];
    if (JSON.stringify(pa) !== JSON.stringify(pb) && !sk.has('::' + ps))
      props.push([ps === 'b' ? '::before' : '::after', JSON.stringify(pa), JSON.stringify(pb)]);
  }
  return props;
}
/** 两份快照逐元素比。skip = { 元素路径: Set(属性, 'g' 表示位置大小, '*' 表示整个元素) } */
function styleDiff(A, B, skip = {}) {
  const dom = [],
    changes = [],
    text = [];
  for (const [p, a] of A.map) {
    const b = B.map.get(p);
    const sk = skip[p] || new Set();
    if (sk.has('*') || a.x) continue;
    if (!b) {
      dom.push(missingLine(p, a));
      continue;
    }
    if (a.c !== b.c) dom.push('类名变了 ' + p + '：' + a.c + ' → ' + b.c);
    const textChanged = (a.t || '') !== (b.t || '');
    if (textChanged) text.push(p);
    const props = propChanges(A, B, a, b, sk);
    const geo = !textChanged && !sk.has('g') && moved(a, b);
    if (props.length || geo) changes.push({ p, c: b.c, t: b.t, props, g: geo ? [a.g, b.g] : null });
  }
  for (const p of B.map.keys())
    if (!A.map.has(p) && !(skip[p] && skip[p].has('*'))) dom.push('多了 ' + p);
  return { dom, changes, text };
}

/** 一个状态两遍之间会变的元素：{ 元素路径: [属性…, 'g' 位置大小, '*' 整个元素] } */
function unstableProps(d) {
  const u = {};
  for (const c of d.changes)
    u[c.p] = [
      ...c.props.map((x) => x[0].replace(/^::(before|after)$/, (m, w) => '::' + w[0])),
      ...(c.g ? ['g'] : []),
    ];
  for (const p of d.text) (u[p] ??= []).push('g');
  for (const line of d.dom) {
    const p = (/html[^\s：]*/.exec(line) || [line])[0];
    (u[p] ??= []).push('*');
  }
  return u;
}

/** 两遍基线之间会变的：元素属性、像素 */
export async function computeUnstable(p1, p2, MODES) {
  const unstable = {};
  for (const mode of readdirSync(p1).filter((m) => MODES[m])) {
    if (!existsSync(join(p2, mode))) continue;
    for (const f of readdirSync(join(p1, mode))) {
      if (!f.endsWith('.json') || f.startsWith('_') || !existsSync(join(p2, mode, f))) continue;
      const id = f.slice(0, -5);
      const A = load(join(p1, mode, f)),
        B = load(join(p2, mode, f));
      const u = unstableProps(styleDiff(A, B));
      if (Object.keys(u).length) (unstable[mode] ??= {})[id] = u;
      const px = await pixelDiff(
        join(p1, mode, id + '.png'),
        join(p2, mode, id + '.png'),
        null,
        null,
      );
      if (px.changed)
        writeFileSync(join(p1, mode, id + '.mask.gz'), gzipSync(dilate(px.map, px.w)));
      if (px.size) (unstable[mode] ??= {})[id] = { ...(unstable[mode]?.[id] || {}), __size: ['*'] };
    }
  }
  return unstable;
}

// 源码里的规则位置：把浏览器里的选择器对回 src/ 下的 .css 文件和行号
function sourceIndex() {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith('.css')) files.push(join(d, e.name));
    }
  };
  walk(join(root, 'src'));
  const idx = new Map();
  for (const f of files) {
    const t = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    const re = /([^{};]+)\{/g;
    let m;
    while ((m = re.exec(t))) {
      const pre = m[1].trim();
      if (!pre || pre.startsWith('@')) continue;
      const line = t.slice(0, m.index + m[0].length - m[1].trimStart().length).split('\n').length;
      let depth = 0,
        cur = '';
      const parts = [];
      for (const ch of pre) {
        if (ch === '(' || ch === '[') depth++;
        if (ch === ')' || ch === ']') depth--;
        if (ch === ',' && depth === 0) {
          parts.push(cur);
          cur = '';
        } else cur += ch;
      }
      parts.push(cur);
      for (const p of parts) {
        const k = normSel(p);
        if (!idx.has(k)) idx.set(k, []);
        idx.get(k).push(relative(root, f).replaceAll('\\', '/') + ':' + line);
      }
    }
  }
  return idx;
}
function normSel(s) {
  return s
    .replace(/(\[[\w-]+[~|^$*]?=)\s*(['"])(.*?)\2\s*\]/g, '$1$3]')
    .replace(/\s*([>+~,()])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/::(before|after)/g, ':$1')
    .trim();
}

/** 一个有差异的状态在对比结果里的几行 */
function sceneLines(title, diffName, d, px) {
  const shot = px.size
    ? '大小变了 ' + px.size
    : px.changed
      ? `${px.changed} 个像素不同（${((px.changed / px.total) * 100).toFixed(3)}%），标红图 diff/${diffName}.png`
      : '相同';
  const lines = [`### ${title}`, `- 截图：${shot}`];
  if (d.dom.length)
    lines.push(
      `- 页面结构变了 ${d.dom.length} 处（这次比对针对样式，结构变了说明组件也改了）：` +
        d.dom.slice(0, 5).join('；'),
    );
  if (d.text.length) lines.push(`- 文字内容变了 ${d.text.length} 处（这些元素不比位置大小）`);
  for (const c of d.changes.slice(0, 25))
    lines.push(
      `- \`${c.c ? '.' + c.c.trim().split(/\s+/).join('.') : c.p.split('>').pop()}\`${c.t ? '（' + c.t + '）' : ''}：` +
        [
          ...c.props.map(([k, a, b]) => `${k} ${a} → ${b}`),
          ...(c.g ? [`位置大小 ${c.g[0].join(',')} → ${c.g[1].join(',')}`] : []),
        ].join('；'),
    );
  if (d.changes.length > 25)
    lines.push(`- ……另有 ${d.changes.length - 25} 个元素，见 _细节.json`);
  return lines;
}

/** 基线和这一遍逐个状态比样式和截图，跳过基线两遍之间会变的 */
async function diffScenes({ baseDir, curDir, diffDir, MODES, unstable }) {
  const s = { lines: [], totalStyle: 0, totalDom: 0, totalPx: 0, scenesWithDiff: 0, compared: 0, missing: [], details: {} };
  for (const mode of readdirSync(baseDir).filter((m) => MODES[m])) {
    for (const f of readdirSync(join(baseDir, mode)).filter(
      (f) => f.endsWith('.json') && !f.startsWith('_'),
    )) {
      const id = f.slice(0, -5);
      if (!existsSync(join(curDir, mode, f))) {
        s.missing.push(`${MODES[mode].label} ${id}`);
        continue;
      }
      s.compared++;
      const skipRaw = unstable[mode]?.[id] || {};
      const skip = Object.fromEntries(Object.entries(skipRaw).map(([p, l]) => [p, new Set(l)]));
      const A = load(join(baseDir, mode, f));
      const d = styleDiff(A, load(join(curDir, mode, f)), skip);
      const maskFile = join(baseDir, mode, id + '.mask.gz');
      const mask = existsSync(maskFile) ? gunzipSync(readFileSync(maskFile)) : null;
      const px = await pixelDiff(
        join(baseDir, mode, id + '.png'),
        join(curDir, mode, id + '.png'),
        mask,
        join(diffDir, `${mode}-${id}.png`),
        textRects(A, d.text),
      );
      const pxBad = px.size || px.changed;
      if (d.changes.length || d.dom.length || pxBad) {
        s.scenesWithDiff++;
        s.totalStyle += d.changes.length;
        s.totalDom += d.dom.length;
        s.totalPx += px.changed || 0;
        s.details[`${mode}/${id}`] = d;
        s.lines.push(...sceneLines(`${MODES[mode].label} · ${id}`, `${mode}-${id}`, d, px));
      }
    }
  }
  return s;
}

/** 从没命中的规则：当前这一遍，所有模式、所有状态合起来 */
function ruleHits(curDir, MODES) {
  const hit = new Set(),
    all = new Set(),
    untestable = new Set();
  for (const mode of readdirSync(curDir).filter((m) => MODES[m]))
    for (const f of ['_hits.json', '_setup_hits.json']) {
      const p = join(curDir, mode, f);
      if (!existsSync(p)) continue;
      const h = JSON.parse(readFileSync(p, 'utf8'));
      Object.keys(h.hit).forEach((k) => hit.add(k));
      h.all.forEach((k) => all.add(k));
      h.untestable.forEach((k) => untestable.add(k));
    }
  const never = [...all].filter((k) => !hit.has(k) && !untestable.has(k));
  return { hit, all, untestable, never };
}
function neverHitLines(never) {
  const idx = sourceIndex();
  const neverLines = never.map((k) => {
    const [media, sel] = k.split('⟫');
    const at = idx.get(normSel(sel));
    return `${at ? at.join('、') : '（源码里没对上）'}  ${media ? media.replace(/ \/ $/, '') + ' ' : ''}${sel}`;
  });
  neverLines.sort();
  return neverLines;
}

/** Chrome 的覆盖率：样式表里用到的字节 */
function coverageLines(curDir, MODES) {
  const used = new Map(),
    totals = new Map();
  for (const mode of readdirSync(curDir).filter((m) => MODES[m]))
    for (const f of ['_coverage.json', '_setup_coverage.json']) {
      const p = join(curDir, mode, f);
      if (!existsSync(p)) continue;
      for (const c of JSON.parse(readFileSync(p, 'utf8'))) {
        totals.set(c.url, c.total);
        const set = used.get(c.url) || new Uint8Array(c.total);
        for (const r of c.ranges) set.fill(1, r.start, r.end);
        used.set(c.url, set);
      }
    }
  return [...used].map(
    ([url, set]) =>
      `${url.replace(/^https?:\/\/[^/]+/, '')}：用到 ${((set.reduce((a, b) => a + b, 0) / totals.get(url)) * 100).toFixed(1)}%（${totals.get(url)} 字节）`,
  );
}

function reportHead({ baseDir, curDir, modeCount, unstable, scenes, rules, covLines }) {
  const { compared, scenesWithDiff, totalStyle, totalDom, totalPx, missing } = scenes;
  const { all, hit, never, untestable } = rules;
  return [
    '# 样式比对结果',
    '',
    `- 基线：${baseDir}`,
    `- 这一遍：${curDir}`,
    `- 比了 ${compared} 个状态（${modeCount} 种模式），**有差异的 ${scenesWithDiff} 个**：样式或位置变了的元素 ${totalStyle} 个，结构变了 ${totalDom} 处，不同的像素 ${totalPx} 个。`,
    `- 基线两遍之间会变、已跳过的（抖动）：${Object.values(unstable).reduce((a, m) => a + Object.keys(m).length, 0)} 个状态里的 ${Object.values(unstable).reduce((a, m) => a + Object.values(m).reduce((b, s) => b + Object.keys(s).length, 0), 0)} 个元素，以及 *.mask.gz 标出的像素。`,
    missing.length
      ? `- 基线有、这一遍没截到的 ${missing.length} 个（用了 --only、--modes 时正常）：${missing.slice(0, 10).join('、')}${missing.length > 10 ? '……' : ''}`
      : '- 基线里的状态这一遍都截到了。',
    `- 样式规则（按选择器算，伪类按元素在就算${missing.length ? '；这一遍没跑全，下面的数只算跑了的状态' : ''}）：共 ${all.size} 条，命中过 ${hit.size} 条，**从没命中 ${never.length} 条**（清单：从没命中的规则.txt），查不了的 ${untestable.size} 条。`,
    `- Chrome 覆盖率：${covLines.join('；') || '没有记录'}`,
    '',
    '## 有差异的状态',
    '',
  ];
}

export async function compare({ dir, MODES, modeCount }) {
  const baseDir = join(dir, 'baseline'),
    curDir = join(dir, 'current'),
    diffDir = join(dir, 'diff');
  if (!existsSync(baseDir)) throw new Error('还没有基线，先跑 baseline');
  rmSync(diffDir, { recursive: true, force: true });
  mkdirSync(diffDir, { recursive: true });
  const unstable = existsSync(join(baseDir, '_unstable.json'))
    ? JSON.parse(readFileSync(join(baseDir, '_unstable.json'), 'utf8'))
    : {};
  const scenes = await diffScenes({ baseDir, curDir, diffDir, MODES, unstable });
  writeFileSync(join(dir, '_细节.json'), JSON.stringify(scenes.details));
  const rules = ruleHits(curDir, MODES);
  writeFileSync(join(dir, '从没命中的规则.txt'), neverHitLines(rules.never).join('\n') + '\n');
  const covLines = coverageLines(curDir, MODES);
  const head = reportHead({ baseDir, curDir, modeCount, unstable, scenes, rules, covLines });
  writeFileSync(
    join(dir, '对比结果.md'),
    [...head, ...(scenes.lines.length ? scenes.lines : ['没有。'])].join('\n') + '\n',
  );
  console.log(head.slice(4, 8).join('\n'));
  console.log('详情：' + join(dir, '对比结果.md'));
  return scenes.scenesWithDiff;
}

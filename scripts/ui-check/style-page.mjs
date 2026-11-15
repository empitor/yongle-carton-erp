// 样式比对在页面里跑的两段（style-compare.mjs 用 page.evaluate 带进页面）：取每个元素的计算样式和位置大小、
// 记下哪些样式规则命中过。page.evaluate 只带过去函数本身，所以用到的小函数都写在函数里面，不能引用这个文件里别的东西。
export function snapshotInPage({ props, pseudoProps, ignore }) {
  const skip = new Set([
    'SCRIPT',
    'STYLE',
    'LINK',
    'META',
    'HEAD',
    'TITLE',
    'NOSCRIPT',
    'TEMPLATE',
  ]);
  const ignored = new Set(ignore.flatMap((s) => [...document.querySelectorAll(s)]));
  const styles = [],
    index = new Map();
  const intern = (o) => {
    const k = JSON.stringify(o);
    if (!index.has(k)) index.set(k, styles.push(o) - 1);
    return index.get(k);
  };
  const els = [];
  // 这几个函数都在页面里跑（page.evaluate 只带过去这一个函数），所以写在里面
  /** 元素自己的文字（不含子元素），输入框再加上填的值 */
  const ownText = (el) => {
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    let t = own ? (own.length > 30 ? own.slice(0, 30) + '…' : own) : undefined;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') t = (t || '') + '｜' + String(el.value).slice(0, 30);
    return t;
  };
  const pseudoStyles = (el, rec) => {
    for (const [ps, key] of [
      ['::before', 'b'],
      ['::after', 'a'],
    ]) {
      const pc = getComputedStyle(el, ps);
      if (pc.content && pc.content !== 'none' && pc.content !== 'normal') {
        const o = {};
        for (const p of pseudoProps) o[p] = pc.getPropertyValue(p);
        rec[key] = intern(o);
      }
    }
  };
  const walk = (el, path, skipIt, pinned) => {
    if (skip.has(el.tagName)) return;
    skipIt = skipIt || ignored.has(el);
    const cs = getComputedStyle(el);
    const rec = { p: path, c: el.getAttribute('class') || '' };
    if (skipIt) rec.x = 1;
    const t = ownText(el);
    if (t !== undefined) rec.t = t;
    if (cs.display === 'none') {
      rec.s = intern({ display: 'none' });
      els.push(rec);
      return;
    }
    const r = el.getBoundingClientRect();
    // 固定、粘性定位的元素和它里面的按窗口坐标记，其余按整页坐标记：页面滚动多少都不影响
    pinned = pinned || cs.position === 'fixed' || cs.position === 'sticky';
    const [ox, oy] = pinned ? [0, 0] : [scrollX, scrollY];
    rec.g = [r.x + ox, r.y + oy, r.width, r.height].map((v) => Math.round(v * 2) / 2);
    if (pinned) rec.f = 1;
    const s = {};
    for (const p of props) s[p] = cs.getPropertyValue(p);
    rec.s = intern(s);
    pseudoStyles(el, rec);
    els.push(rec);
    if (el.tagName.toLowerCase() === 'svg') return;
    let i = 0;
    for (const ch of el.children)
      walk(ch, path + '>' + ch.tagName.toLowerCase() + ++i, skipIt, pinned);
  };
  walk(document.documentElement, 'html', false, false);
  return {
    styles,
    els,
    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    view: [scrollX, scrollY],
  };
}

export function hitsInPage(known) {
  const splitTop = (s) => {
    const out = [];
    let depth = 0,
      cur = '';
    for (const ch of s) {
      if (ch === '(' || ch === '[') depth++;
      if (ch === ')' || ch === ']') depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  // 状态伪类和伪元素去掉再查：鼠标悬停、聚焦这类只要元素在就算命中
  const strip = (s) =>
    s
      .replace(
        /::?(?:-webkit-[\w-]+|-moz-[\w-]+|before|after|placeholder|selection|marker|backdrop|file-selector-button|first-line|first-letter)(?![\w-])/g,
        '',
      )
      .replace(
        /:(?:hover|focus-visible|focus-within|focus|active|visited|target|popover-open)(?![\w-])/g,
        '',
      );
  const hit = [],
    all = [],
    untestable = [];
  const check = (part, media) => {
    const key = media + '⟫' + part;
    all.push(key);
    if (known[key]) return;
    let sel = strip(part).trim();
    if (!sel || /^[>+~]/.test(sel) || /\(\s*\)/.test(sel)) sel = part;
    try {
      if (document.querySelector(sel)) hit.push(key);
    } catch {
      untestable.push(key);
    }
  };
  const visit = (rules, media) => {
    for (const r of rules) {
      if (r instanceof CSSStyleRule) {
        for (const part of splitTop(r.selectorText)) check(part, media);
      } else if (r.cssRules)
        visit(
          r.cssRules,
          media + r.cssText.slice(0, r.cssText.indexOf('{')).trim().replace(/\s+/g, ' ') + ' / ',
        );
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      visit(sheet.cssRules, '');
    } catch {
      /* 别的来源的样式表读不了，跳过 */
    }
  }
  return { hit, all, untestable };
}

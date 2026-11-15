// 识别结果按栏和标准答案比（real-recognition.mjs 用；纯函数）。
// 订单的识别结果每栏是 { value, certainty }：certainty 为 needs-review 且有值算“报了拿不准”；到货的结果每栏是字，拿不准写在 warnings。
// 明细行不按行号比：先在标准答案的行和识别出的行之间做最大匹配（DocILE 发票基准的做法），配上的逐栏比，
// 配不上的分别记“漏了一行”“多了一行”。这样漏读或多读一行，只算那一行，后面的行不会跟着错位全错。

const DATE = new Set(['orderDate', 'deliveryDate', 'date']);
const NUMBER = new Set(['length', 'width', 'height', 'quantity', 'unitPrice', 'area', 'taxRate']);
const empty = (v) => v === null || v === undefined || String(v).trim() === '';
const squash = (v) => String(v).replace(/\s+/g, '').replace(/[×xX*＊]/g, 'x').replace(/有限公司|公司$/g, '').toLowerCase();
/** 日期统一成 YYYY-MM-DD；没写年份的只留 MM-DD */
function day(v) {
  const m = /(?:(\d{4})\s*[-/.年]\s*)?(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(String(v));
  if (!m) return String(v);
  const md = m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  return m[1] ? m[1] + '-' + md : md;
}
const num = (v) => Number(String(v).replace(/[^\d.-]/g, ''));
/** 一栏对不对：答案是数组时任一种写法都算对；答案 null 时要留空 */
export function cellOk(field, got, want) {
  if (Array.isArray(want)) return want.some((w) => cellOk(field, got, w));
  if (want === null) return empty(got);
  if (empty(got)) return false;
  if (DATE.has(field)) {
    const g = day(got), w = day(want);
    // 原件没写年份：留着没年份或补成今年都算对，补成别的年份算错
    return g === w || (w.length === 5 && g === new Date().getFullYear() + '-' + w);
  }
  if (NUMBER.has(field)) return num(got) === num(want);
  const g = squash(got), w = squash(want);
  // 单位名称可以多写或少写“有限公司”这类后缀；别的栏读出来的要包含答案（“五金配件箱”丢了“大”“小”不算对）
  if (/Name$/.test(field) && field !== 'productName') return g === w || (w.length >= 2 && g.length >= 2 && (g.includes(w) || w.includes(g)));
  return g === w || (w.length >= 2 && g.includes(w));
}

/** 配对时看的栏：品名、规格（货号、长宽高）、数量。订单行和到货行栏名不同，答案里有哪栏用哪栏 */
const KEY = new Set(['productName', 'name', 'productCode', 'length', 'width', 'height', 'quantity']);
/** 一个标准答案行配一个识别行的分：这几栏读对一栏记 100，其余栏读对一栏记 1（只用来在相近的配法里分高下）；
 *  这几栏一栏都没对上就不配（0），宁可记成漏一行、多一行，也不硬配。原件没写的栏（答案 null）不拿来配对 */
function likeness(want, got) {
  let score = 0;
  for (const [field, w] of Object.entries(want))
    if (w !== null && cellOk(field, got[field]?.value ?? null, w)) score += KEY.has(field) ? 100 : 1;
  return score >= 100 ? score : 0;
}
/** 最大匹配（识别行是 shape 之后的 {栏: {value}}）：让配上的各对分数加起来最大，一一对应。返回每个答案行配到的识别行下标，配不上是 -1。
 *  行数很少（单据一般不到 20 行），按“答案第几行、哪些识别行已用”记忆化穷举就够 */
export function pairLines(wantLines, gotLines) {
  if (gotLines.length > 30) throw new Error(`识别出 ${gotLines.length} 行，超过配对能算的 30 行`);
  const score = wantLines.map((w) => gotLines.map((g) => likeness(w, g)));
  const memo = new Map();
  const best = (i, used) => {
    if (i === wantLines.length) return { total: 0, pick: [] };
    const key = i + ':' + used;
    if (memo.has(key)) return memo.get(key);
    const skip = best(i + 1, used);
    let top = { total: skip.total, pick: [-1, ...skip.pick] };
    gotLines.forEach((_, j) => {
      if (used & (1 << j) || !score[i][j]) return;
      const rest = best(i + 1, used | (1 << j));
      if (rest.total + score[i][j] > top.total) top = { total: rest.total + score[i][j], pick: [j, ...rest.pick] };
    });
    memo.set(key, top);
    return top;
  };
  return best(0, 0).pick;
}

/** 订单、到货结果统一成 { header: {栏: {value, flagged}}, lines: [...] , warnings } */
function shape(kind, result) {
  if (kind === 'order') {
    const cell = (f) => ({ value: f?.value ?? null, flagged: f?.certainty === 'needs-review' && !empty(f?.value) });
    return {
      header: Object.fromEntries(Object.entries(result?.header ?? {}).map(([k, f]) => [k, cell(f)])),
      lines: (result?.lines ?? []).map((l) => Object.fromEntries(Object.entries(l.fields ?? {}).map(([k, f]) => [k, cell(f)]))),
      warnings: result?.warnings ?? [],
    };
  }
  const cell = (v) => ({ value: v ?? null, flagged: false });
  const { lines = [], warnings = [], ...head } = result ?? {};
  return { header: Object.fromEntries(Object.entries(head).map(([k, v]) => [k, cell(v)])), lines: lines.map((l) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, cell(v)]))), warnings };
}

/** 一份文件一次识别的得分：表头和配上的明细行逐栏对错、拿不准报得对不对、该空的空没空；漏的行、多的行单独数 */
export function scoreCase(c, result) {
  const got = shape(c.kind, result);
  const pick = pairLines(c.lines, got.lines);
  const cells = [];
  const add = (part, line, field, want, from) => {
    const g = (part === 'header' ? got.header : got.lines[from])[field] ?? { value: null, flagged: false };
    cells.push({ part, line, field, want, got: g.value, ok: cellOk(field, g.value, want), flagged: g.flagged });
  };
  for (const [f, w] of Object.entries(c.header)) add('header', null, f, w);
  c.lines.forEach((l, i) => pick[i] >= 0 && Object.entries(l).forEach(([f, w]) => add('line', i, f, w, pick[i])));
  const wantNull = (x) => x.want === null || (Array.isArray(x.want) && x.want.includes(null) && empty(x.got));
  return {
    cells: cells.length,
    right: cells.filter((x) => x.ok).length,
    lineCount: got.lines.length,
    wantLines: c.lines.length,
    /** 答案里有、没配上识别行的行数；识别出来、没配上答案的行数 */
    missingLines: pick.filter((j) => j < 0).length,
    extraLines: got.lines.length - pick.filter((j) => j >= 0).length,
    missed: cells.filter((x) => !x.ok && empty(x.got) && !wantNull(x)).length,
    invented: cells.filter((x) => !x.ok && !empty(x.got) && x.want === null).length,
    flagRight: cells.filter((x) => x.flagged && !x.ok).length,
    flagNoise: cells.filter((x) => x.flagged && x.ok).length,
    flagMissed: cells.filter((x) => !x.flagged && !x.ok && !empty(x.got)).length,
    priceExact: cells.filter((x) => x.field === 'unitPrice' && x.want !== null).every((x) => String(x.got ?? '').trim() === String(x.want)),
    warnings: got.warnings.length,
    detail: cells,
  };
}

const sum = (rs, k) => rs.reduce((n, r) => n + (r[k] ?? 0), 0);
const usageOf = (r) => (r.traffic ?? []).reduce((a, t) => ({ input: a.input + (t.usage?.input ?? 0), output: a.output + (t.usage?.output ?? 0) }), { input: 0, output: 0 });
/** 前后两批结果出对比表（markdown） */
export function summarizeRuns([before, after], labels) {
  const rows = [];
  const line = (...cells) => rows.push('| ' + cells.join(' | ') + ' |');
  const ok = (rs) => rs.filter((r) => !r.error);
  rows.push('| | 识别次数 | 失败 | 读对的栏 / 总栏（表头和配上的行） | 漏了的行 | 多出的行 | 漏填 | 编了原件没有的 | 报了拿不准且确实错 | 报了拿不准其实对 | 错了没报 | 单价照原文小数位 | 平均请求次数（>1 是重试） | 平均输入 / 输出 token | 平均秒数 | 每次请求系统提示 + 工具字数 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  [before, after].forEach((rs, i) => {
    const good = ok(rs);
    const u = good.map(usageOf);
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const req = good.flatMap((r) => r.traffic ?? []);
    line(labels[i], rs.length, rs.length - good.length, `${sum(good, 'right')} / ${sum(good, 'cells')}`, sum(good, 'missingLines'), sum(good, 'extraLines'), sum(good, 'missed'), sum(good, 'invented'), sum(good, 'flagRight'), sum(good, 'flagNoise'), sum(good, 'flagMissed'),
      `${good.filter((r) => r.priceExact).length} / ${good.length}`, avg(good.map((r) => (r.traffic ?? []).length)).toFixed(2),
      `${Math.round(avg(u.map((x) => x.input)))} / ${Math.round(avg(u.map((x) => x.output)))}`, (avg(good.map((r) => r.ms)) / 1000).toFixed(1),
      Math.round(avg(req.map((t) => t.systemChars + t.toolChars))));
  });
  rows.push('', '每份文件（按遍数排，每遍读对的栏 / 总栏，漏了、多了行的另写）：', '', '| 文件 | ' + labels.join(' | ') + ' |', '|---|---|---|');
  const lines = (r) => (r.missingLines ? ` 漏${r.missingLines}行` : '') + (r.extraLines ? ` 多${r.extraLines}行` : '');
  for (const id of [...new Set([...before, ...after].map((r) => r.case))]) {
    const cell = (rs) =>
      rs.filter((x) => x.case === id).sort((a, b) => a.run - b.run).map((r) => (r.error ? '失败' : `${r.right}/${r.cells}` + lines(r))).join('、') || '—';
    line(id + ' ' + ([...before, ...after].find((r) => r.case === id)?.title ?? ''), cell(before), cell(after));
  }
  rows.push('', '每一栏（全部文件、全部遍数里读对的次数 / 出现次数）：', '', '| 栏 | ' + labels.join(' | ') + ' |', '|---|---|---|');
  const fields = [...new Set([...before, ...after].flatMap((r) => (r.detail ?? []).map((d) => d.part + ':' + d.field)))];
  for (const f of fields) {
    const per = (rs) => {
      const ds = ok(rs).flatMap((r) => r.detail ?? []).filter((d) => d.part + ':' + d.field === f);
      return `${ds.filter((d) => d.ok).length} / ${ds.length}`;
    };
    line(f.replace('header:', '表头 ').replace('line:', '明细 '), per(before), per(after));
  }
  return rows.join('\n');
}

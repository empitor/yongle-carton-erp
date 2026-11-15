// 真实模型冒烟：先起 node scripts/ui-check/preview.mjs --real-model（在设置页填好 DeepSeek 密钥），再运行
//   node scripts/ui-check/real-smoke.mjs --yes [--port 3197] [--only chat,image]
// 只走 HTTP、登录虚构管理员，测到 DeepSeek 的每一种接口；虚构文件当场现造，不进仓库。
// 脚本拿不到也不打印密钥。每项打印通过或失败和耗时，结尾打印一共向 DeepSeek 发了几次请求。
// 会产生少量费用（预计不到 0.1 元），所以连真实 DeepSeek 时必须带 --yes；连假 DeepSeek 自测（preview 加 --fake-deepseek）不用。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(new URL('../../package.json', import.meta.url));
const ExcelJS = require('exceljs');
const { createCanvas, PDFDocument, loadImage } = require('@napi-rs/canvas');

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = option('--port') || '3197';
const only = option('--only')?.split(',');
const BASE = 'http://127.0.0.1:' + port;

// —— 登录虚构管理员（密码在 server.mts 的种子里） ——
const seed = readFileSync(new URL('./server.mts', import.meta.url), 'utf8');
const password = /add\('虚构管理员',\s*'([^']+)'/.exec(seed)?.[1];
const state = await fetch(BASE + '/api/auth/state').then((r) => r.json(), () => null);
if (!state?.csrf) throw new Error(`端口 ${port} 上没有预览实例，先运行 node scripts/ui-check/preview.mjs --real-model`);
const login = await fetch(BASE + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': state.csrf },
  body: JSON.stringify({ name: '虚构管理员', password }),
});
if (!login.ok) throw new Error('登录虚构管理员失败：HTTP ' + login.status);
const cookie = login.headers.get('set-cookie').split(';')[0];
const call = async (name, body) => {
  const r = await fetch(BASE + '/__real-smoke/' + name, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (r.status === 404) throw new Error('这个实例不是真实模型模式（没有测试入口），请用 preview.mjs --real-model 启动');
  return r.json();
};
const mode = await call('count');
if (!mode.hasKey) throw new Error('还没保存 DeepSeek 密钥：请在这个实例的 设置 → API 配置 里填好再跑');
if (!mode.fake && !args.includes('--yes')) {
  console.log('会调用真实 DeepSeek 并产生少量费用（预计不到 0.1 元）。确认要跑就加 --yes。');
  process.exit(2);
}
console.log(mode.fake ? '连的是假 DeepSeek（自测）' : '连的是真实 DeepSeek');

// —— 现造的虚构文件 ——
async function fictionalXlsx() {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('虚构订单');
  sheet.mergeCells('A1:E1');
  sheet.getCell('A1').value = '虚构客户甲 采购订单（测试数据，不是真实订单）';
  sheet.addRow([]);
  sheet.addRow(['品名', '规格', '数量（只）', '单价（元）', '交货日期']);
  sheet.addRow(['虚构纸箱A', '300×200×150', 500, 1.3, new Date(Date.UTC(2026, 11, 1))]);
  sheet.addRow(['虚构纸箱B', '200×150×100', 800, 0.7312, new Date(Date.UTC(2026, 11, 8))]);
  sheet.getColumn(4).numFmt = '0.0000';
  sheet.getColumn(5).numFmt = 'yyyy-mm-dd';
  sheet.mergeCells('A6:C6');
  sheet.getCell('A6').value = '合计（合并单元格）';
  const hidden = book.addWorksheet('隐藏的备注');
  hidden.state = 'hidden';
  hidden.addRow(['这一页是隐藏的工作表，虚构备注']);
  hidden.addRow(['隐藏编号', 'HX-7731']);
  return Buffer.from(await book.xlsx.writeBuffer());
}
function fictionalPng() {
  const c = createCanvas(900, 360),
    ctx = c.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = 'black';
  ctx.font = '28px "Microsoft YaHei", sans-serif';
  ['虚构送货单（测试数据）', '品名：虚构纸箱A  数量：500只', '单价：1.2345元  日期：2026-12-01'].forEach((s, i) =>
    ctx.fillText(s, 30, 70 + i * 90),
  );
  return c.toBuffer('image/png');
}
/** PDF 里那张图：只画几个大字，看模型读没读到 PDF 里的图片 */
function bigWordsPng() {
  const c = createCanvas(900, 360),
    ctx = c.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = 'black';
  ctx.font = 'bold 150px "Microsoft YaHei", sans-serif';
  ctx.fillText('虚构样箱', 140, 240);
  return c.toBuffer('image/png');
}
async function fictionalPdf(png) {
  const pdf = new PDFDocument({ title: 'Fictional order' });
  const ctx = pdf.beginPage(800, 1000);
  ctx.fillStyle = 'black';
  ctx.font = '22px "Microsoft YaHei", sans-serif';
  ctx.fillText('虚构采购订单（测试数据，不是真实订单）', 40, 60);
  const rows = [
    ['品名', '数量（只）', '单价（元）', '交货日期'],
    ['虚构纸箱A', '500', '1.2345', '2026-12-01'],
    ['虚构纸箱B', '800', '0.7312', '2026-12-08'],
  ];
  rows.forEach((row, r) => {
    row.forEach((text, c) => {
      ctx.strokeRect(40 + c * 170, 100 + r * 44, 170, 44);
      ctx.fillText(text, 50 + c * 170, 130 + r * 44);
    });
  });
  ctx.drawImage(await loadImage(png), 40, 300, 600, 240);
  pdf.endPage();
  return Buffer.from(pdf.close());
}
function wav(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** 模型读文件的结果逐项比对：读对 / 读错 / 没读到（只打印，不影响这一项通过与否） */
function check(title, answer, expected) {
  const norm = (v) => String(v ?? '').replace(/\s+/g, '').replace(/[/.年月]/g, '-').replace(/日$/, '');
  for (const [key, [label, want]] of Object.entries(expected)) {
    const got = answer?.[key];
    // 单价按数值比（表格里显示 1.3000，DeepSeek 读到的是数值 1.3，是同一个数），其余项允许多带字
    const exact = /^\d+\.\d+$/.test(want);
    const verdict = got === null || got === undefined || got === '' ? '没读到' : (exact ? Number(got) === Number(want) : norm(got) === norm(want) || norm(got).includes(norm(want))) ? '读对' : '读错';
    console.log(`    ${title}·${label}：${verdict}（要 ${want}，读到 ${got ?? '无'}）`);
  }
}

/** 文件那两项的分段耗时：上传解析（传到 DeepSeek 并拿到文件编号）、模型回答 */
function timing(title, result) {
  console.log(`    ${title}·耗时：上传解析 ${result.uploadMs} 毫秒，模型回答 ${result.answerMs} 毫秒`);
}

// —— 逐项跑 ——
const png = fictionalPng();
const results = [];
let spoken = null;
async function step(name, label, run) {
  if (only && !only.includes(name)) return;
  const started = Date.now();
  let line;
  try {
    const r = await run();
    line = r.ok ? '通过' : '失败';
    results.push(r.ok);
    console.log(`${line}  ${label}  ${Date.now() - started} 毫秒  ${JSON.stringify(r.ok ? r.result : { code: r.code, message: r.message }, (k, v) => (k === 'pcm' ? '（' + String(v).length + ' 字）' : v)).slice(0, 200)}`);
    return r;
  } catch (error) {
    results.push(false);
    console.log(`失败  ${label}  ${Date.now() - started} 毫秒  ${String(error?.message || error).slice(0, 200)}`);
  }
}
await step('balance', '查余额', () => call('balance', {}));
await step('chat', '最短的对话', () => call('chat', {}));
const table = await step('table', '上传虚构表格、引用后删除', async () =>
  call('file', {
    name: '虚构订单.xlsx',
    purpose: 'user_data',
    data: (await fictionalXlsx()).toString('base64'),
    question:
      '按原样照抄，输出 JSON：priceA=虚构纸箱A 那一行的单价，priceB=虚构纸箱B 那一行的单价（都照文件里的数写，不要四舍五入），dateA=虚构纸箱A 的交货日期（YYYY-MM-DD），merged=第一行合并单元格里的标题全文，hidden=隐藏工作表里“隐藏编号”旁边的值。',
  }),
);
if (table?.ok) {
  timing('表格', table.result);
  check('表格', table.result.answer, {
    priceA: ['单价（显示 1.3000）', '1.3'], priceB: ['单价（四位小数）', '0.7312'],
    dateA: ['日期', '2026-12-01'],
    merged: ['合并单元格', '虚构客户甲 采购订单（测试数据，不是真实订单）'],
    hidden: ['隐藏工作表的值', 'HX-7731'],
  });
}
const pdfStep = await step('pdf', '上传虚构 PDF（含一张图）、引用后删除', async () =>
  call('file', {
    name: '虚构订单.pdf',
    purpose: 'rich_layout_recognition',
    data: (await fictionalPdf(bigWordsPng())).toString('base64'),
    question: '按原样照抄，输出 JSON：qtyB=表格里虚构纸箱B 的数量，imageText=表格下面那张图片里写的几个大字。',
  }),
);
if (pdfStep?.ok) {
  timing('PDF', pdfStep.result);
  check('PDF', pdfStep.result.answer, { qtyB: ['表格里的数', '800'], imageText: ['图片里的大字', '虚构样箱'] });
}
await step('image', '图片内联', () => call('image', { data: png.toString('base64'), question: '图片里的单价是多少？' }));
const tts = await step('tts', '朗读一句话', () => call('tts', { text: '测试订单五百只' }));
if (tts?.ok) spoken = wav(Buffer.from(tts.result.pcm, 'base64'), tts.result.sampleRate);
await step('asr', '一段录音的识别', () => {
  // 朗读没成功就用 1 秒的提示音（识别结果多半是空的，只验证接口通）
  const audio =
    spoken ??
    wav(Buffer.from(Int16Array.from({ length: 16000 }, (_, i) => Math.round(Math.sin(i / 8) * 8000)).buffer), 16000);
  return call('asr', { data: audio.toString('base64') });
});
await step('search', '搜索一次', () => call('search', { query: '五层瓦楞纸板 是什么' }));
await step('fetch', '读一个公开网页', () => call('fetch', { url: 'https://api-docs.deepseek.com/zh-cn/' }));

const total = await call('count');
const failed = results.filter((ok) => !ok).length;
console.log(`一共 ${results.length} 项，通过 ${results.length - failed}，失败 ${failed}；这次向 DeepSeek 一共发了 ${total.calls - mode.calls} 次请求`);
process.exitCode = failed ? 1 : 0;

// 识别（订单、到货）真实接口前后对比：直接走识别导入的接口（上传 → 识别 → 读识别结果），不经过助手对话。
// 文件和标准答案在 real-recognition-cases.mjs；每份跑几遍，按栏比读对没有、“拿不准”报得准不准、空着的是不是原件真没写，
// 另记每份的对话请求次数（大于 1 就是交回不合格又试了）、输入输出 token、秒数，以及请求里点名工具、开没开思考。
//   node scripts/ui-check/real-recognition.mjs --start --port 3196 --label 改后 --yes [--runs 2] [--first 3] [--only O1,A2] [--out 目录]
//   node scripts/ui-check/real-recognition.mjs --compare 改前目录 改后目录
// --start 自己起本机管理员模式的真实模型实例（在哪个目录跑就起哪份代码），跑完关掉。只发现造的虚构文件。
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNTS, Session, startPreview, stopPreviews } from './real-suite-client.mjs';
import { CASES } from './real-recognition-cases.mjs';
import { scoreCase, summarizeRuns } from './real-recognition-score.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const load = (dir) => readFileSync(join(dir, 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

if (args.includes('--compare')) {
  const i = args.indexOf('--compare');
  // 按现在的标准答案重新打分（答案改过也能直接重比）
  const rescore = (rs) => rs.map((r) => (r.result ? { ...r, ...scoreCase(CASES.find((c) => c.id === r.case), r.result) } : r));
  const runs = [rescore(load(args[i + 1])), rescore(load(args[i + 2]))];
  console.log(summarizeRuns(runs, [args[i + 3] ?? '改前', args[i + 4] ?? '改后']));
  process.exit(0);
}

const port = option('--port', '3196');
const label = option('--label', '');
const times = Number(option('--runs', '2'));
/** 接着以前的结果往下跑时，第几遍开始编号 */
const first = Number(option('--first', '1'));
const picks = option('--only')?.split(',');
const out = option('--out', join(tmpdir(), 'erp-recognition-' + new Date().toISOString().replace(/[:.]/g, '-')));
mkdirSync(out, { recursive: true });
if (args.includes('--start'))
  await startPreview({ root: fileURLToPath(new URL('../../', import.meta.url)), port, fake: args.includes('--fake'), log: join(out, 'instance.log') });

const s = await new Session('http://127.0.0.1:' + port, ACCOUNTS.local).login();
const count = await s.smoke('count');
if (!count.hasKey) throw new Error('这个实例还没保存 DeepSeek 密钥');
const cases = CASES.filter((c) => !picks || picks.includes(c.id));
if (!count.fake && !args.includes('--yes')) {
  console.log(`会调用真实 DeepSeek 并产生费用（${cases.length} 份 × ${times} 遍）。确认要跑就加 --yes。`);
  process.exit(2);
}
console.log(`${count.fake ? '假 DeepSeek' : '真实 DeepSeek'}；${label}；${cases.length} 份 × ${times} 遍；结果写到 ${out}`);
// 识别工作区的写入要带它自己的页面凭证（工作区列表里给）
const aiToken = (await s.api('/api/ai/imports')).csrfToken;
const aiHeaders = { 'X-ERP-AI-Token': aiToken };
const post = (path, body) => s.request(path, body, 'POST', aiHeaders);

async function recognize(c) {
  const file = await c.file();
  await s.smoke('traffic', {}); // 清掉之前的
  const started = Date.now();
  const up = await fetch(s.base + '/api/ai/imports/upload', {
    method: 'POST',
    headers: { ...s.headers, ...aiHeaders, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Import-Mode': c.kind },
    body: file.bytes,
  });
  const body = await up.json().catch(() => ({}));
  const ws = body.workspace ?? {};
  if (!up.ok || !ws.id) return { error: '上传：' + (body.message ?? up.status), ms: Date.now() - started };
  const run =
    c.kind === 'order'
      ? await post(`/api/ai/imports/${ws.id}/analyze`, { expectedRevision: ws.revision, stream: false, force: true })
      : await post(`/api/ai/imports/${ws.id}/arrival/recognize`, { stream: false, force: true });
  const ms = Date.now() - started;
  await new Promise((r) => setTimeout(r, 300)); // 等最后一次请求的用量读完
  const traffic = await s.smoke('traffic', {});
  if (!run.ok) return { error: run.message, ms, traffic };
  const result = c.kind === 'order' ? (await s.request(`/api/ai/imports/${ws.id}`)).body?.draft : (run.body?.result ?? run.body?.document?.result ?? run.body);
  return { result, ms, traffic };
}

for (let n = first; n < first + times; n++)
  for (const c of cases) {
    const r = await recognize(c).catch((e) => ({ error: '脚本出错：' + e.message, ms: 0 }));
    const traffic = r.traffic?.result ?? [];
    const record = { label, case: c.id, kind: c.kind, title: c.title, run: n, error: r.error ?? null, ms: r.ms, traffic, ...(r.result ? scoreCase(c, r.result) : {}), result: r.result ?? null };
    appendFileSync(join(out, 'records.jsonl'), JSON.stringify(record) + '\n');
    const u = traffic.reduce((a, t) => ({ input: a.input + (t.usage?.input ?? 0), output: a.output + (t.usage?.output ?? 0) }), { input: 0, output: 0 });
    console.log([c.id, '第' + n + '遍', record.error ? '失败：' + record.error.slice(0, 80) : `读对 ${record.right}/${record.cells}` + (record.missingLines ? ` 漏${record.missingLines}行` : '') + (record.extraLines ? ` 多${record.extraLines}行` : ''), `请求 ${traffic.length}`, `入 ${u.input} 出 ${u.output}`, (r.ms / 1000).toFixed(1) + '秒',
      traffic.filter((t) => t.status >= 400).map((t) => `上游 ${t.status}：${t.error}`).join('；')].join(' | '));
  }
const after = await s.smoke('count');
console.log(`共发 ${after.calls - count.calls} 次请求（含上传文件）。详细：${out}`);
stopPreviews();
process.exit(0);

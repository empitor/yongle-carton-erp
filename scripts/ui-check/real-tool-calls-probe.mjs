// DeepSeek 工具调用的探测：核对 DeepSeek 官方文档没写清楚的几处（思考内容回传、历史回放办法 A/B、并行调用、
// max_tokens 算不算思考、各档位的思考量）。先起 node scripts/ui-check/preview.mjs --real-model（设置页填好密钥），再运行
//   node scripts/ui-check/real-tool-calls-probe.mjs --yes [--port 3197] [--only tool-round,history-a]
//   node scripts/ui-check/real-tool-calls-probe.mjs --list        只列场景，不发请求
// 只走真实模型实例的 HTTP 测试入口（/__real-smoke/tool-calls，只认超级管理员），脚本拿不到也不打印密钥。
// 会产生少量费用（每个场景一两次最小请求，efforts 四次），所以连真实 DeepSeek 时必须带 --yes；
// 连假 DeepSeek 自测（preview 加 --fake-deepseek）不用。结果只打印，不算通过或失败。
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const scenarios = [
  ['tool-round', '思考开 + 一个工具：调工具、接上结果、再答'],
  ['drop-reasoning', '第二次请求去掉上一条助手消息的思考内容（文档说会 400）'],
  ['system-mid', '工具结果后面插一条 system 消息'],
  ['history-a', '历史办法 A：不带思考的 user/assistant 文字回放'],
  ['history-b', '历史办法 B：前几轮整理成一条 system 消息'],
  ['history-a-after-tools', '历史办法 A：上一轮调过工具，只回放文字'],
  ['parallel', '一句话查两张订单：一次回复几个工具调用'],
  ['max-tokens', '思考 token 算不算进 max_tokens'],
  ['efforts', '四个档位的思考量和耗时'],
];
if (args.includes('--list')) {
  for (const [name, label] of scenarios) console.log(`${name.padEnd(22)} ${label}`);
  process.exit(0);
}
const port = option('--port') || '3197';
const only = option('--only')?.split(',');
const BASE = 'http://127.0.0.1:' + port;

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
  console.log('会调用真实 DeepSeek 并产生少量费用（全部场景约十几次最小请求）。确认要跑就加 --yes。');
  process.exit(2);
}
console.log(mode.fake ? '连的是假 DeepSeek（自测）' : '连的是真实 DeepSeek');

for (const [name, label] of scenarios) {
  if (only && !only.includes(name)) continue;
  const started = Date.now();
  try {
    const r = await call('tool-calls', { scenario: name });
    console.log(`\n== ${name}  ${label}  ${Date.now() - started} 毫秒`);
    console.log(JSON.stringify(r.ok ? r.result : { 没跑成: true, code: r.code, status: r.status, message: r.message }, null, 2));
  } catch (error) {
    console.log(`\n== ${name}  没跑成  ${String(error?.message || error).slice(0, 200)}`);
  }
}
const total = await call('count');
console.log(`\n这次向 DeepSeek 一共发了 ${total.calls - mode.calls} 次请求`);

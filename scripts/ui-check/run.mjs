// 界面实测：构建到临时目录，起隔离实例，用无头 Chrome 走主要流程。截图留在输出的临时目录里。
// 需要本机装了 Chrome，或设置 CHROME_PATH。不碰 data/、backups/ 和正式实例，也不覆盖项目的 dist。
//
// 用法：
//   npm run test:ui                     全部流程（发布前跑）
//   npm run test:ui -- production mobile 只跑这几组；写组名或组里任一流程名都行
//   npm run test:ui -- --list           列出各组
// 各组用自己的端口（3201 起，不占预览用的 3199/3198）和自己的实例，默认同时跑 6 组（UI_CHECK_JOBS 改）。
// 每组的输出边跑边写进截图目录的 group-<组名>.log，服务端输出写进 group-<组名>-server.log；
// 流程中途出错时 lib.mjs 在截图目录留 FAIL-<流程>-N.png 和 trace（npx playwright show-trace 回放）。
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const here = fileURLToPath(new URL('./', import.meta.url));

// 同一组的流程按顺序共用一个实例的状态；不同组互不相干。财务各组开头用接口自己准备前置数据，不依赖别的组。
// 按大约用时从长到短排：同时跑的组数少于组数时，长的先开跑。
// 新加的 flow-*.mjs 要写进某一组，不然永远不跑（tests/ui-check-groups.test.mjs 查）。
export const groups = [
  { name: 'finance-close', flows: ['closing'], about: '撤销核销和收款、银行流水、发票、保证金、费用、工资、成本计提结转结账报表反结账、压款利息和逾期' },
  { name: 'finance', flows: ['basics', 'ledger'], about: '启用财务、资金账户、账期、各页签；补税、生成凭证、提交审核记账、收款核销、叫法' },
  { name: 'spirits', flows: ['spirits', 'web', 'speech', 'enter-send'], about: '助手悬浮球和聊天窗；联网过程（状态行、先说的那句、来源）；代码没加载完就点助手也能打开；语音输入录音（假麦克风，连录两次）；输入框回车发送、Shift+回车换行、输入法选字和手机上回车不发送' },
  { name: 'mobile', flows: ['mobile', 'app-bridge'], about: '手机宽度；安卓 App 通道：没登录先接通、登录后分享进 AI 导入，几 MB 的文件，超 10MB 不上传，纯财务账号被回绝；返回键按层级（含筛选浮层）；导出订货单经通道保存，存好才改状态、没存成不改；顶栏收起、滑到头只拉伸内容区' },
  { name: 'settings', flows: ['settings'], about: '设置页签、三家机器人已连接、数据管理报错位置、修改历史叫法、批量归档提示、AI 导入导航数字、全站深色和窄窗口' },
  { name: 'finance-more', flows: ['finance-more'], about: '带期初启用、票据到期、预算、员工借款、资产处置、蓝票红票' },
  { name: 'finance-scenes', flows: ['scenes'], about: '已送货未开票、利息接着算、启用前单据、派生凭证撤回和红字冲销' },
  { name: 'operations', flows: ['operations', 'remote', 'stock', 'corrections'], about: '新订单、完工入库、到货更正、退货撤销、助手删除卡片、网关出错、域名模式超级管理员；新建采购单到登记到货、安排送货到导出并出库、出入库和盘点；送货、完工更正和说明编辑（数据管理里也一样）' },
  { name: 'access', flows: ['permission', 'cashier', 'supermode'], about: '业务员看不到财务、出纳账号；从域名访问改账号和设置要先进超级管理员模式（电脑、手机宽度）' },
  { name: 'production', flows: ['production', 'batches'], about: '附属品、筛选、订单编辑窗明细、安排生产、登记完工窗；成品批次块和批次备注' },
  { name: 'account', flows: ['account', 'busy'], about: '账号、改密、登录；服务器正忙时自动再试一次' },
  { name: 'records', flows: ['intake', 'records'], about: '收件箱标为已处理和恢复、文件转订单、AI 导入改一格后导入订单；新建客户和供应商、归档页恢复、初始化业务数据（最后一步，真清空）' },
  { name: 'a11y', flows: ['a11y'], about: '无障碍检查（axe）：今日、订单、仓库、采购、财务概览、数据管理、助手面板各扫一遍，只列违规不拦' },
];
/** 流程名对应的脚本文件（和本文件在同一目录） */
export const flowFile = (flow) => 'flow-' + flow + '.mjs';

/** 按命令行挑组：--list 列出后退出；写了不认识的组名、流程名报错退出 */
function pickGroups(args) {
  if (args.includes('--list')) {
    for (const g of groups) console.log(g.name.padEnd(15) + g.flows.join(', ').padEnd(24) + '  ' + g.about);
    process.exit(0);
  }
  const wanted = args.filter((a) => !a.startsWith('-'));
  const unknown = wanted.filter((w) => !groups.some((g) => g.name === w || g.flows.includes(w)));
  if (unknown.length) {
    console.error('没有这个流程：' + unknown.join('、') + '。用 --list 看有哪些。');
    process.exit(1);
  }
  return wanted.length ? groups.filter((g) => wanted.some((w) => g.name === w || g.flows.includes(w))) : groups;
}

const seconds = (from) => Math.round((Date.now() - from) / 1000) + ' 秒';
const alive = (port) => fetch(`http://127.0.0.1:${port}/api/auth/state`).then(() => true, () => false);
async function runGroup(group, port, { dir, baseEnv }) {
  // 每组自己的配置目录和本地数据目录，同时跑的实例互不影响；截图都放在同一个目录里，文件名前缀各不相同。
  const own = join(dir, 'group-' + group.name);
  mkdirSync(own, { recursive: true });
  const log = join(dir, 'group-' + group.name + '.log');
  const write = (text) => appendFileSync(log, text);
  const env = {
    ...baseEnv,
    UI_CHECK_PORT: String(port),
    LOCALAPPDATA: join(own, 'localappdata'),
    ERP_CONFIG_DIR: join(own, 'config'),
    DB_PATH: join(own, 'never-used.sqlite'),
  };
  // 端口上已有别的实例时，连上去会测到旧数据，直接报错。
  if (await alive(port)) return { group, output: '', problems: [`端口 ${port} 已被占用，请先关掉上一个实测实例。`] };
  const from = Date.now();
  const serverLog = createWriteStream(join(dir, 'group-' + group.name + '-server.log'));
  const server = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), join(here, 'server.mts')], { cwd: dir, env });
  server.stdout.pipe(serverLog);
  server.stderr.pipe(serverLog);
  const problems = [];
  let output = '';
  try {
    let up = false;
    for (let i = 0; i < 90 && !up && server.exitCode === null; i++) {
      up = await alive(port);
      if (!up) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!up) return { group, output, problems: ['隔离实例没有启动，服务端输出见 ' + join(dir, 'group-' + group.name + '-server.log')] };
    for (const flow of group.flows) {
      const file = flowFile(flow);
      const flowFrom = Date.now();
      write(`\n── ${file} ──\n`);
      const { code, signal, text } = await new Promise((resolve) => {
        const child = spawn(process.execPath, [join(here, file)], { env });
        let text = '';
        // UI_CHECK_TIMES=1 时每行前面标上流程开始后的秒数，找慢在哪一步
        const add = (b) => {
          const chunk = process.env.UI_CHECK_TIMES
            ? String(b).replace(/^(?=.)/gm, () => `[${String(Math.round((Date.now() - flowFrom) / 1000)).padStart(3)}s] `)
            : String(b);
          text += chunk;
          write(chunk);
        };
        child.stdout.on('data', add);
        child.stderr.on('data', add);
        child.on('close', (code, signal) => resolve({ code, signal, text }));
      });
      output += `\n── ${file}（${seconds(flowFrom)}）──\n` + text;
      // 被系统杀掉时 code 是 null，也算没跑完；附上最后 20 行，免得终端截断时看不到原因
      if (code !== 0)
        problems.push(
          file + ' 中途失败' + (signal ? '（进程被 ' + signal + ' 终止）' : '') + '，日志 ' + log + '：\n    ' +
            text.trimEnd().split('\n').slice(-20).join('\n    '),
        );
      for (const line of text.split('\n'))
        if (/ERR: |dialog error|still open|costing err/.test(line)) problems.push(file + '：' + line.trim());
    }
  } finally {
    server.kill();
    await new Promise((r) => (server.exitCode === null ? server.once('close', r) : r()));
    serverLog.end();
  }
  return { group, output, problems, took: seconds(from) };
}

async function main(args) {
  const picked = pickGroups(args);
  const dir = mkdtempSync(join(tmpdir(), 'erp-ui-check-'));
  const started = Date.now();
  const baseEnv = { ...process.env, UI_CHECK_DIR: dir.replaceAll('\\', '/'), UI_CHECK_REMOTE: '' };
  const vite = join(root, 'node_modules/vite/bin/vite.js');
  const built = spawnSync(process.execPath, [vite, 'build', '--outDir', join(dir, 'dist'), '--emptyOutDir'], {
    cwd: root,
    env: baseEnv,
    stdio: 'ignore',
  });
  if (built.status !== 0) throw new Error('构建失败');
  console.log('构建用了 ' + seconds(started) + '，开始跑：' + picked.map((g) => g.name).join('、') + '\n日志和截图：' + dir);

  // 默认同时跑 6 组，其余排队、长的组先跑：12 组全开每组慢一倍多、机器忙时会超时，6 组总用时差不多、稳得多
  const jobs = Math.max(1, Number(process.env.UI_CHECK_JOBS) || 6);
  const queue = picked.map((group) => ({ group, port: 3201 + groups.indexOf(group) }));
  const results = [];
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const result = await runGroup(next.group, next.port, { dir, baseEnv });
        // 一组跑完整段输出，几组的日志不交错
        process.stdout.write(`\n════ ${result.group.name}（${result.took || '未跑完'}）════` + result.output + '\n');
        results.push(result);
      }
    }),
  );
  const problems = results.flatMap((r) => r.problems.map((p) => r.group.name + ' / ' + p));
  console.log('\n截图目录：' + dir);
  console.log('共用了 ' + seconds(started) + '：' + results.map((r) => r.group.name + ' ' + (r.took || '-')).join('，'));
  if (problems.length) {
    console.error('有 ' + problems.length + ' 处问题：\n' + problems.join('\n'));
    process.exitCode = 1;
  } else console.log('界面实测通过');
}

// 被守卫测试引来读组表时不跑
if (import.meta.main) await main(process.argv.slice(2));

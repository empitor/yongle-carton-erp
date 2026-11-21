// 根目录每个文件、文件夹是干什么的。GitHub 的文件列表右边显示的是“最后改动这一项的那次提交的说明”，
// 所以每次发布给根目录每一项各补一次提交，说明写它的作用，列表上看到的就是这份清单。
//   node scripts/root-notes.mjs                 只核对：根目录每一项都有说明、没有多余的
//   node scripts/root-notes.mjs --commit 0.9.5  真做（工作区要干净）：先一次提交把每一项都动一下（文件末尾加一个换行，
//                                               文件夹动里面的一个文件），再一项一次提交恢复原样；做完内容和做之前一字不差
//   加 --only docs,scripts                      只标这几项：两次发布之间推了改动，把动过的那几项重新标一遍
import { execFileSync } from 'node:child_process';
import { appendFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** 根目录的每一项和它的作用（一句话，GitHub 列表里放得下） */
export const rootNotes = {
  '.claude': '给 Claude Code 的项目配置：子智能体须知、审查员、技能、保护真实数据的钩子',
  '.env.example': '环境变量示例（不填密钥，密钥在网页设置里填）',
  '.gitattributes': '换行规则：脚本和结构快照固定换行，检出后校验才对得上',
  '.gitignore': '不进仓库的东西：数据、备份、密钥、安装包、缓存',
  '.jscpd.json': '重复代码检查的配置（npm run dup，上限只许调低）',
  'AGENTS.md': '项目协作规则：给 AI 和开发者的硬规则，开工前先读',
  'CLAUDE.md': 'Claude Code 专用说明：引用 AGENTS.md，另说钩子和技能',
  LICENSE: '许可：代码公开，版权归公司所有，保留所有权利',
  'README.md': '项目介绍：是什么、谁在用、部署在哪、怎么装和跑',
  'THIRD_PARTY_NOTICES.md': '第三方代码和字体的出处、许可',
  apps: '两个应用外壳：安卓 App、Windows 客户端（只是打开 ERP 的窗口）',
  docs: '文档：架构、数据模型、功能链路、使用手册、部署运维、路线图、更新日志',
  'eslint-suppressions.json': '代码检查的豁免登记（已清空，不许再登记）',
  'eslint.config.js': '代码检查（ESLint）的规则',
  'index.html': '网页的入口页',
  'knip.json': '“没人用的代码”检查（knip）的配置',
  'package-lock.json': '依赖的确切版本（锁文件）',
  'package.json': '项目清单：版本号、依赖、各条 npm 命令',
  public: '原样发给浏览器的静态文件：图标、主题初始化脚本',
  scripts: '脚本：启动、构建、打包、补丁、各项检查、界面实测',
  server: '服务端程序：接口、业务规则、读写数据库、AI 接入、助手',
  shared: '前后端共用：类型、校验、金额和单位的计算、业务规则',
  src: '前端页面（React）：各业务页面、助手面板、公共界面件',
  'stryker.config.mjs': '变异测试（npm run mutation）的配置',
  'stylelint.config.mjs': '样式检查的规则：颜色、字号、圆角只许写变量',
  tests: '自动测试：业务规则、接口、结构检查、发布检查',
  'tsconfig.json': 'TypeScript 的编译配置',
  'vite.config.ts': '前端构建和开发服务器（Vite）的配置',
  '停止系统.cmd': 'Windows 上双击：停止本机的 ERP',
  '启动系统.cmd': 'Windows 上双击：启动本机的 ERP 并打开浏览器',
};

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
/** 能在末尾加一个换行又不坏的文本文件 */
const TEXT_FILE = /\.(md|ts|tsx|mjs|js|json|css|html|svg|txt|cmd|sh|yml|toml|kts|java|rs)$|(^|\/)(LICENSE|\.gitignore|\.gitattributes|\.env\.example)$/;

/**
 * 这一项里拿哪个文件来动一下：文件就是它自己；文件夹取里面第一个进了仓库的文本文件
 * （不往文件夹里放新文件，新文件可能被 .gitignore 挡掉）
 */
function touchTarget(entry) {
  if (!statSync(entry).isDirectory()) return entry;
  const file = git('ls-files', '-z', '--', entry).split('\0').find((f) => TEXT_FILE.test(f));
  if (!file) throw new Error(entry + ' 里没找到能动的文本文件');
  return file;
}

/** 进了仓库的根目录各项（按暂存区算，刚加进来还没提交的也算） */
export const rootEntries = () => [
  ...new Set(
    git('ls-files', '-z')
      .split('\0')
      .filter(Boolean)
      .map((file) => file.split('/')[0]),
  ),
];

/** 清单和根目录对不上的地方：缺说明的、多出来的 */
export function noteProblems(entries, notes = rootNotes) {
  return [
    ...entries.filter((e) => !notes[e]).map((e) => `${e}：根目录有这一项，scripts/root-notes.mjs 里没写它的作用`),
    ...Object.keys(notes)
      .filter((e) => !entries.includes(e))
      .map((e) => `${e}：清单里有，根目录已经没有这一项，从 scripts/root-notes.mjs 里删掉`),
  ];
}

function commitNotes(version, only) {
  const all = rootEntries();
  const problems = noteProblems(all);
  if (problems.length) throw new Error(problems.join('\n'));
  const unknown = (only ?? []).filter((e) => !all.includes(e));
  if (unknown.length) throw new Error('根目录没有这几项：' + unknown.join('、'));
  const entries = only ? all.filter((e) => only.includes(e)) : all;
  if (git('status', '--porcelain')) throw new Error('工作区有没提交的改动，先提交或收好再标。');
  const base = git('rev-parse', 'HEAD');
  const targets = entries.map((e) => [e, touchTarget(e)]);
  for (const [, file] of targets) appendFileSync(file, '\n');
  git('add', '--', ...targets.map(([, file]) => file));
  git('commit', '-q', '-m', `发布 ${version}：给根目录每一项重新标注作用（准备，下面逐项恢复原样）`);
  for (const [e, file] of targets) {
    git('checkout', base, '--', file);
    git('commit', '-q', '-m', `${rootNotes[e]}（${version}）`);
  }
  if (git('diff', '--stat', base, 'HEAD')) throw new Error('标完以后内容和原来不一样，检查哪里出了岔子：git diff ' + base + ' HEAD');
  console.log(`标好了 ${entries.length} 项，内容和 ${base.slice(0, 7)} 一字不差。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--commit');
  if (at < 0) {
    const problems = noteProblems(rootEntries());
    console.log(problems.length ? problems.join('\n') : '根目录每一项都有说明。');
    process.exitCode = problems.length ? 1 : 0;
  } else {
    const version = process.argv[at + 1];
    if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('用法：node scripts/root-notes.mjs --commit 版本号 [--only 项,项]');
    const onlyAt = process.argv.indexOf('--only');
    commitNotes(version, onlyAt < 0 ? undefined : (process.argv[onlyAt + 1] ?? '').split(',').filter(Boolean));
  }
}

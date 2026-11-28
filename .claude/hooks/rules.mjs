// 挡板规则（三家共用）：把 AGENTS.md“碰不得的”里能机器判断的几条变成挡板。判断写在本文件和 data-commands.mjs
// （命令碰真实数据目录那几条）；路径怎么统一和比对在 paths.mjs，命令怎么拆成段和词在 shell-words.mjs。
// 拦（deny）：读写真实数据和本机受保护目录（含连带整个 data/、backups/ 的删除、复制：根目录、通配、git clean -x、git stash -a、
// find -delete、管道删除）、密钥和 .env、覆盖 dist 的构建、启动正式服务和动真实数据的维护命令、
// 不经 npm test 直接跑测试、改定下不许改的文件（文件工具和命令行写入都算）、往代码检查里登记豁免。
// 先问（ask）：连正式实例的地址、启停正式实例（本机的停止、服务器上的正式服务）、连真实模型的脚本、改检查的配置；
// 命令前缀清单另在 .claude/settings.json 的 permissions.ask。
// 只拦明确命中的路径和命令。路径按长名比：Windows 的 8.3 短名（ADMINI~1）先展开成长名，两种写法都查。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataCommandReason } from './data-commands.mjs';
import { DATA_RULE, absolute, dataReason, longPath, norm, pathForms, protectedDataDir } from './paths.mjs';
import { commandSegments, commandName, programOf } from './shell-words.mjs';

/** 本机数据目录（%LOCALAPPDATA%）下不能碰的目录（小写）和理由 */
const LOCAL_DIRS = {
  zhixuerp: '不能读写 %LOCALAPPDATA%\\ZhixuERP 里的真实数据' + DATA_RULE,
  'erp-real-model-test':
    '不能读、打印或复制真实模型测试实例存密钥的目录（%LOCALAPPDATA%\\erp-real-model-test），命令行里也不写它的路径，preview.mjs 自己拼（.claude/skills/ui-check/SKILL.md“真实模型模式”）。',
  '甬勒erp测试':
    '不能动本机装的桌面测试版（%LOCALAPPDATA%\\甬勒ERP测试），安装验证由人做（apps/desktop/docs/README.md）。',
};
const LOCAL_IN_COMMAND = new RegExp(
  '(?:appdata/+local|%localappdata%|\\$\\{?localappdata\\}?|\\$env:localappdata)/+(' +
    Object.keys(LOCAL_DIRS).join('|') + ')',
);
/** 定下不许改的文件（相对项目根目录，小写）；existing 的只拦改已有的，新加配置库要导出新的基线快照 */
const LOCKED = [
  {
    path: 'tests/fixtures/schema-v20.sql',
    reason: '第 20 版结构快照已发布，不许改；改结构在 server/core/schema/steps.ts 末尾加编号的升级步骤（.claude/skills/schema-change/SKILL.md）。',
  },
  {
    path: 'tests/fixtures/config-db/',
    existing: true,
    reason: '配置库的基线快照定下以后不许改；改配置库在它规格的 steps 末尾加一步（规矩在 server/core/backup/versioned-sqlite-spec.ts 开头）。',
  },
  {
    path: 'eslint-suppressions.json',
    reason: 'eslint-suppressions.json 已清空，不许往里登记：报错就改代码（docs/架构/代码检查.md“检查是防火墙”）。',
  },
];
/** 检查的配置（相对项目根目录，小写）：改它可能放宽或关掉自动检查，要用户同意 */
const CHECK_CONFIGS = [
  'eslint.config.js',
  'scripts/eslint-local-rules.mjs',
  'stylelint.config.mjs',
  '.jscpd.json',
  'knip.json',
  'scripts/complexity-baseline.json',
  'scripts/check.mjs',
];
/**
 * 正式实例的地址（真实数据），只在用户要求时只读查看：127.x.x.x 的各种简写、localhost、0、0.0.0.0、方括号里的 IPv6
 * （[::1]、[::ffff:127.0.0.1]）加 :3001。本机名、局域网地址和拼出来的端口认不出。
 */
const OFFICIAL_INSTANCE =
  /(?<![\w.-])(?:127(?:\.\d{1,3}){0,3}|localhost|0(?:\.0){0,3}|\[[0-9a-f:.]+\]):3001(?!\d)/i;
/** 服务器上正式服务的启停、开机自启和屏蔽（服务名见 docs/运维/部署.md）：systemctl 前后带选项的、service 写法的都认 */
const OFFICIAL_SERVICE = new RegExp(
  'systemctl(?:\\s+-{1,2}[\\w-]+(?:=\\S+)?)*\\s+' +
    '(?:start|stop|restart|try-restart|reload-or-restart|kill|reload|mask|disable|enable|isolate)' +
    '(?:\\s+-{1,2}[\\w-]+(?:=\\S+)?)*\\s+(?:\\S+\\s+)*yongle-carton-erp\\b' +
    '|\\bservice\\s+yongle-carton-erp(?:\\.service)?\\s+(?:start|stop|restart|reload|force-reload)\\b',
  'i',
);

/** 读 Claude 的 Bash、PowerShell 命令前缀，Antigravity 共用这份审批清单。 */
export function readAskRules(root) {
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
  return settings.permissions.ask.flatMap((rule) => {
    const match = /^(Bash|PowerShell)\(([^()*]+) \*\)$/.exec(rule);
    if (!match) return [];
    return [{ tool: match[1], prefix: match[2].toLowerCase().split(/\s+/) }];
  });
}

/** 统一过的绝对路径碰到的受保护位置：拦下的理由，没碰到返回空串 */
function pathReason(abs, roots) {
  const dir = protectedDataDir(abs, roots);
  if (dir) return dataReason(dir);
  const local = /\/appdata\/local\/([^/]+)/.exec(abs)?.[1];
  if (local && Object.hasOwn(LOCAL_DIRS, local)) return LOCAL_DIRS[local];
  if (/\.pem$/.test(abs)) return '不能读取或改动密钥文件（.pem），密钥不进聊天和日志。';
  if (/\/\.env(\.[a-z0-9_-]+)?$/.test(abs) && !abs.endsWith('/.env.example'))
    return '不能读取或改动 .env，里面是密钥和本机配置，不进聊天和日志；参考字段看 .env.example。';
  return '';
}

/** 文件类工具给的路径：解析成绝对路径后比对（短名写法展开后也比一遍）。 */
export function checkPath(raw, roots, cwd) {
  if (!raw || typeof raw !== 'string') return '';
  return pathForms(absolute(cwd, raw)).map((abs) => pathReason(abs, roots)).find(Boolean) || '';
}

/** 写入的路径相对哪个项目根目录（小写、正斜杠），不在项目里返回 null */
function inProject(raw, roots, cwd) {
  if (!raw || typeof raw !== 'string') return null;
  for (const abs of pathForms(absolute(cwd, raw))) {
    const root = roots.find((r) => abs.startsWith(r + '/'));
    if (root) return abs.slice(root.length + 1);
  }
  return null;
}

/** 写入定下不许改的文件：拦下的理由；可以写返回空串 */
export function lockedReason(raw, roots, cwd) {
  const rel = inProject(raw, roots, cwd);
  if (rel === null) return '';
  const hit = LOCKED.find(({ path }) => (path.endsWith('/') ? rel.startsWith(path) : rel === path));
  if (!hit || (hit.existing && !existsSync(absolute(cwd, raw)))) return '';
  return hit.reason;
}

/** 写入检查的配置：要用户确认的理由；不是返回空串 */
export function checkConfigReason(raw, roots, cwd) {
  const rel = inProject(raw, roots, cwd);
  if (rel === null || !CHECK_CONFIGS.includes(rel)) return '';
  return '改 ' + rel + ' 可能放宽或关掉自动检查，要用户同意才能改（AGENTS.md“碰不得的”），请用户确认。';
}

/** 连正式实例、启停服务器上的正式服务（命令文字或浏览器地址）：要用户确认的理由 */
export function officialInstanceReason(text) {
  if (typeof text !== 'string') return '';
  if (OFFICIAL_SERVICE.test(text))
    return '这是启停服务器上的正式实例，要用户同意才能做（AGENTS.md“碰不得的”），请用户确认。';
  if (!OFFICIAL_INSTANCE.test(text)) return '';
  return '127.0.0.1:3001 是正式实例（真实数据），只在用户要求时只读查看，请用户确认；平时用测试实例（.claude/skills/ui-check/SKILL.md）。';
}

/** 命令文字里带 ~数字 的路径换成展开短名后的绝对路径，别的原样 */
const longPathsIn = (command, cwd) =>
  command.replace(/[^\s"'`;|&<>(){}=,]*~\d[^\s"'`;|&<>(){}]*/g, (word) => {
    const abs = absolute(cwd, word);
    const long = longPath(abs);
    return long === abs ? word : long;
  });

/** 命令行（Bash / PowerShell / cmd）：按文字匹配，只认明确指向受保护位置的写法；带短名的路径展开后再查一遍。 */
export function checkCommand(command, roots, cwd) {
  if (!command || typeof command !== 'string') return '';
  const reason = commandReason(command, roots, cwd);
  if (reason) return reason;
  const long = longPathsIn(command, cwd);
  return long === command ? '' : commandReason(long, roots, cwd);
}

function commandReason(command, roots, cwd) {
  const text = norm(command);
  const data = dataCommandReason(command, roots, cwd);
  if (data) return data;
  const local = LOCAL_IN_COMMAND.exec(text);
  if (local) return LOCAL_DIRS[local[1]];
  // 密钥：只允许作为 ssh/scp 的 -i 身份文件使用，其他提到 .pem 的命令（cat、复制、读取）都拦。
  for (const m of text.matchAll(/[^\s"'<>|;&]*\.pem\b/g)) {
    const before = text.slice(0, m.index);
    if (!/(?:^|\s)-i\s*["']?$/.test(before))
      return '不能读取、打印或复制密钥文件（.pem），密钥不进聊天和日志。用 ssh 连接时用 -i 指定即可。';
  }
  if (/(?:^|[\s"'=(;|&<>/])\.env(?:\.(?!example\b)[\w-]+)?(?=$|[\s"';|&)<>])/.test(text))
    return '不能读取或改动 .env，里面是密钥和本机配置，不进聊天和日志；参考字段看 .env.example。';
  const build =
    /\bnpm(?:\.cmd)?\s+(?:run|run-script)\s+build(?=$|[\s;&|)"'])/.test(text) ||
    /scripts\/build\.mjs/.test(text) ||
    (/\bvite(?:\.js)?["']?\s+build\b/.test(text) && !/--outdir|--out-dir/.test(text));
  if (build)
    return '正式实例可能在运行，这样构建会覆盖它正在用的 dist（AGENTS.md“碰不得的”）。构建检查输出到临时目录：npx vite build --outDir <临时目录> --emptyOutDir。';
  return runReason(text, cwd);
}

const SERVICE_RULE =
  '会按真实目录启动正式服务（AGENTS.md“碰不得的”）。看代码能不能加载用 npx tsc --noEmit；要起实例用测试实例（.claude/skills/ui-check/SKILL.md）。';
const MAINTENANCE_RULE = '是对真实数据的维护命令（AGENTS.md“碰不得的”），要做请用户自己操作。';
/** 一段命令里用 node、tsx 这类运行器跑脚本 */
const RUNNER = /(?:^|[\s"'(/])(?:node|tsx|bun|deno|ts-node)(?:\.exe|\.cmd)?["']?(?=\s)/;
/** 运行器后面跟着这些入口就拦：正式服务的入口、启动脚本、真实数据的维护脚本 */
const ENTRIES = [
  [/(?<![\w-])server\/index(?:\.[cm]?[jt]s)?(?![\w.-])/, '加载或运行 server/index.ts ' + SERVICE_RULE],
  [/scripts\/(?:start|dev)-system\.mjs/, '运行启动脚本' + SERVICE_RULE],
  [/(?<![\w-])server\/maintenance(?:\.[cm]?[jt]s)?(?![\w.-])/, 'server/maintenance.ts ' + MAINTENANCE_RULE],
];
/** npm 和子命令之间、run 和脚本名之间可以夹 -s、--silent、--loglevel=error 这类开关 */
const NPM_OPTIONS = '(?:\\s+-{1,2}[\\w-]+(?:=\\S*)?)*';
const NPM_RUN = '\\bnpm(?:\\.cmd)?' + NPM_OPTIONS + '\\s+';
const SCRIPT_END = '(?=$|[\\s;&|)"\'])';
const NPM_SCRIPT = new RegExp(
  NPM_RUN + '(?:(start|restart)|(?:run|run-script)' + NPM_OPTIONS +
    '\\s+(start|restart|dev|backup|restore|reset-password|revert-config-upgrades))' + SCRIPT_END,
);
const NPM_STOP = new RegExp(NPM_RUN + '(?:stop|(?:run|run-script)' + NPM_OPTIONS + '\\s+stop)' + SCRIPT_END);
/** 四个数据目录都指到临时目录才能直接跑 --test（AGENTS.md“常用命令”） */
const TEST_DIRS = ['localappdata', 'erp_config_dir', 'db_path', 'erp_backup_dir'].map(
  (name) => new RegExp('(?:^|[\\s;&|("\'])(?:\\$env:)?' + name + '\\s*='),
);

/** 启动正式服务、动真实数据的维护命令、不经 npm test 的测试、往代码检查里登记豁免 */
function runReason(text, cwd) {
  const script = NPM_SCRIPT.exec(text);
  if (script) {
    const name = script[1] || script[2];
    return ['start', 'restart', 'dev'].includes(name)
      ? 'npm ' + (script[1] ? '' : 'run ') + name + ' ' + SERVICE_RULE
      : 'npm run ' + name + ' ' + MAINTENANCE_RULE;
  }
  // 双击启动的脚本和直接跑启动脚本（cmd /c 启动系统.cmd、& .\启动系统.cmd、Start-Process）
  for (const words of commandSegments(text)) {
    const { name, word } = programOf(words);
    if (name === '启动系统' || /scripts\/(?:start|dev)-system\.mjs$/.test(word)) return '运行启动脚本' + SERVICE_RULE;
  }
  const sandboxed = TEST_DIRS.every((dir) => dir.test(text));
  for (const segment of text.split(/[;&|\r\n]+/)) {
    if (!RUNNER.test(segment)) continue;
    const entry = ENTRIES.find(([pattern]) => pattern.test(segment));
    if (entry) return entry[1];
    // 外壳 apps/ 的测试自成一体，不碰 ERP 的数据目录
    const bareTest = /\s--test(?=$|[\s=])/.test(segment) && !sandboxed
      && !/(?:^|[\s"'/])apps\//.test(text) && !/\/apps\//.test(norm(cwd));
    if (bareTest)
      return '直接跑 --test 没把 LOCALAPPDATA、ERP_CONFIG_DIR、DB_PATH、ERP_BACKUP_DIR 四个都指到临时目录，会碰到本机真实数据（AGENTS.md“碰不得的”）。用 npm test -- <测试文件>，它会把数据、配置、备份目录都指进临时目录。';
  }
  if (/--suppress-(?:all|rule)\b/.test(text) && /eslint|npm(?:\.cmd)?\s+run\s+lint/.test(text))
    return 'eslint-suppressions.json 已清空，不许往里登记：报错就改代码（docs/架构/代码检查.md“检查是防火墙”）。';
  return '';
}

const STOP_REASON = '这会停掉本机的正式实例，要用户同意才能做（AGENTS.md“碰不得的”），请用户确认。';
const REAL_MODEL_REASON =
  '这是连真实模型的脚本，会花钱，要用户同意才能跑（AGENTS.md“碰不得的”），请用户确认；自测用假模型（.claude/skills/ui-check/SKILL.md）。';

/** 停本机正式实例、连真实模型（花钱）的命令：要用户确认的理由，三家都由挡板判（前缀清单只认一种写法） */
export function commandAskReason(command) {
  if (!command || typeof command !== 'string') return '';
  const text = norm(command);
  if (NPM_STOP.test(text) || commandSegments(text).some((words) => programOf(words).name === '停止系统'))
    return STOP_REASON;
  for (const segment of text.split(/[;&|\r\n]+/)) {
    if (!RUNNER.test(segment)) continue;
    if (/(?<![\w-])server\/stop(?:\.[cm]?[jt]s)?(?![\w.-])/.test(segment)) return STOP_REASON;
    // 只认文件名：cd scripts/ui-check 以后 node real-smoke.mjs 也算
    const realModel = /(?:^|[\s"'/])real-(?:smoke|suite|recognition)\.mjs/.test(segment);
    if (realModel && /\s--(?:yes|start)(?=$|[\s=])/.test(segment)) return REAL_MODEL_REASON;
  }
  return '';
}

/** 程序名后、子命令前带值的开关（git -C 目录、git -c 键=值、npm --prefix 目录、gh -R 仓库），跳过时连值一起跳 */
const VALUE_OPTIONS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--prefix', '-w', '--workspace', '-r', '--repo']);

/**
 * 每段命令按词匹配审批前缀：npm.cmd、git.exe 等同于无后缀的命令；跳过前置的环境变量赋值和子命令前的开关
 * （git -C . push、npm --save-dev install）；powershell -c "…" 这类引号里的命令另算一段。
 */
export function askReason(command, root) {
  if (!command || typeof command !== 'string') return '';
  const rules = readAskRules(root);
  for (const segment of commandSegments(command)) {
    const words = segment.map((word) => word.toLowerCase());
    let i = 0;
    while (i < words.length && /^[a-z_]\w*=/.test(words[i])) i += 1;
    if (i >= words.length) continue;
    let next = i + 1;
    while (next < words.length && words[next].startsWith('-')) next += VALUE_OPTIONS.has(words[next]) ? 2 : 1;
    const line = [commandName(words[i]), ...words.slice(next)];
    const hit = rules.find(({ prefix }) => prefix.every((part, k) => line[k] === part));
    if (hit)
      return '“' + hit.prefix.join(' ') + '”要用户同意才能做（AGENTS.md“碰不得的”），请用户确认。';
  }
  return '';
}

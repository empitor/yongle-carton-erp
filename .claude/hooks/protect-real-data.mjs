// Claude Code 的 PreToolUse 钩子：把 AGENTS.md 里几条“绝对不能做”变成机器挡板。
// 拦：读写 data/、backups/、%LOCALAPPDATA%\ZhixuERP（真实业务数据），密钥文件（.pem）和 .env，
// 以及会覆盖正式实例 dist 的构建（npm run build、不带 --outDir 的 vite build）。
// 只拦明确命中的路径和命令；拦下时把原因和替代做法告诉 Claude。脚本自己出错时放行，不卡正常工作。
// 测试：tests/claude-hooks.test.mjs。
import { resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_RULE = '（AGENTS.md“绝对不能做”）。测试用 :memory: 或临时目录配虚构数据；确实要动真实数据请用户自己操作。';

/** 统一成小写、正斜杠；Git Bash 的 /c/Users 转成 c:/Users。 */
const norm = (text) =>
  String(text)
    .replaceAll('\\', '/')
    .replace(/(^|[\s"'=(])\/([a-z])\//gi, '$1$2:/')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();

const WINDOWS_PATH = /^[a-z]:[\\/]/i;
/** 拼绝对路径：带盘符的按 Windows 的规矩拼，在哪种系统上跑结果都一样（Linux 上不这样拼会把 C:\… 当成相对路径，该拦的拦不住） */
const absolute = (base, path) => (WINDOWS_PATH.test(path) || WINDOWS_PATH.test(base) ? win32.resolve : resolve)(base, path);

/** 文件类工具给的路径：解析成绝对路径后比对。 */
function checkPath(raw, root, cwd) {
  if (!raw || typeof raw !== 'string') return '';
  const bash = /^\/([a-z])\//i.exec(raw);
  const abs = norm(absolute(cwd, bash ? bash[1] + ':/' + raw.slice(3) : raw)).replace(/\/$/, '');
  for (const dir of ['data', 'backups'])
    if (abs === root + '/' + dir || abs.startsWith(root + '/' + dir + '/'))
      return '不能读写真实业务数据目录 ' + dir + '/' + DATA_RULE;
  if (/\/appdata\/local\/zhixuerp(\/|$)/.test(abs))
    return '不能读写 %LOCALAPPDATA%\\ZhixuERP 里的真实数据' + DATA_RULE;
  if (/\.pem$/.test(abs)) return '不能读取或改动密钥文件（.pem），密钥不进聊天和日志。';
  if (/\/\.env(\.[a-z0-9_-]+)?$/.test(abs) && !abs.endsWith('/.env.example'))
    return '不能读取或改动 .env，里面是密钥和本机配置，不进聊天和日志；参考字段看 .env.example。';
  return '';
}

/** 命令行（Bash / PowerShell）：按文字匹配，只认明确指向受保护位置的写法。 */
function checkCommand(command, root) {
  if (!command || typeof command !== 'string') return '';
  const text = norm(command);
  // 相对路径：data/…、./data/…、backups\…；前面必须是命令行分隔，src/data/ 这类不算。
  const relative = /(?:^|[\s"'=(;|&<>,])(?:\.\/)?(data|backups)\//.exec(text);
  // 进入目录：cd data、Set-Location backups
  const enter = /(?:^|[\s;&|(])(?:cd|pushd|set-location|sl)\s+["']?(?:\.\/)?(data|backups)["']?(?=$|[\s;&|)])/.exec(text);
  // 绝对路径：项目根目录下的 data、backups
  const absolute = new RegExp(
    root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(data|backups)(?=$|[/\\s"\';|&)])',
  ).exec(text);
  const hit = relative || enter || absolute;
  if (hit) return '不能读写真实业务数据目录 ' + hit[1] + '/' + DATA_RULE;
  if (/(?:appdata\/+local|%localappdata%|\$\{?localappdata\}?|\$env:localappdata)\/+zhixuerp/.test(text))
    return '不能读写 %LOCALAPPDATA%\\ZhixuERP 里的真实数据' + DATA_RULE;
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
    return '正式实例可能在运行，这样构建会覆盖它正在用的 dist（AGENTS.md“用户说了才能做”）。构建检查输出到临时目录：npx vite build --outDir <临时目录> --emptyOutDir。';
  return '';
}

export function verdict(input, projectDir) {
  const tool = input?.tool_name || '';
  const args = input?.tool_input || {};
  const root = norm(projectDir || input?.cwd || process.cwd()).replace(/\/$/, '');
  const cwd = input?.cwd || projectDir || process.cwd();
  if (tool === 'Bash' || tool === 'PowerShell') return checkCommand(args.command, root);
  const paths = [args.file_path, args.notebook_path, args.path];
  // Glob 的 pattern 本身就是路径：取第一个通配符之前的部分
  if (tool === 'Glob' && typeof args.pattern === 'string')
    paths.push(absolute(args.path || cwd, args.pattern.split(/[*?[{]/)[0] || '.'));
  for (const p of paths) {
    const reason = checkPath(p, root, cwd);
    if (reason) return reason;
  }
  return '';
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const reason = verdict(JSON.parse(raw || '{}'), process.env.CLAUDE_PROJECT_DIR);
    if (reason)
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }),
      );
  } catch {
    // 钩子自己出错时放行，不能因为挡板坏了把正常工作卡死。
  }
  process.exit(0);
}

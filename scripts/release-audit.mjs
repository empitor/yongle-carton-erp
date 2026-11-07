// 扫描暂存区、当前工作区和历史 blob，只报告文件/规则，不输出密钥内容。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fixturePath = 'tests/fixtures/import/word-extractor-test01.doc';
const fixtureHash = '3aefb1a8370ede7cc3aef1280fe216e9597e2a458a3125bd55dd735109407f33';
const forbidden = /(^|\/)(node_modules|data|backups|work|outputs?|dist|\.playwright-cli|\.cache|\.vite|\.npm|coverage|test-results|playwright-report|\.build-tmp-[^/]+)\/|(^|\/)\.env($|\.(?!example$))|\.(sqlite(?:-\w+)?|db|running|control|pem|key|pfx|p12|onnx|safetensors|tsbuildinfo|log|zip|xlsx?|docx?|pdf)$/i;
const dummy = (s) => /^(sk-(fictional|test|fake|mock|not-a-real|example|dummy|unit|secure-test|masked|super-test)|ghp_example)/i.test(s);
const placeholder = (s) => /^(?:fictional|test|fake|mock|example|dummy|your[_-]|replace[_-]|<)/i.test(s);

export function auditRelease(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  const blob = (hash) => execFileSync('git', ['cat-file', 'blob', hash], { cwd, maxBuffer: 64 * 1024 * 1024 });
  const findings = [];
  const inspect = (name, bytes, scope) => {
    const publicFixture = name === fixturePath && bytes.length === 22528 && createHash('sha256').update(bytes).digest('hex') === fixtureHash;
    if (name === fixturePath && !publicFixture) findings.push({ scope, file: name, rule: '公开夹具大小或SHA256不符，拒绝放行' });
    if (forbidden.test(name) && !publicFixture) {
      findings.push({ scope, file: name, rule: '禁止上传运行数据、凭据或资源（.env.example 除外）' });
      return;
    }
    if (bytes.length > 50 * 1024 * 1024) findings.push({ scope, file: name, rule: '超过50MB，检查大型资源' });
    if (bytes.includes(0)) return;
    const content = bytes.toString('utf8');
    const patterns = [
      ['API密钥', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
      ['GitHub令牌', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{35,})\b/g],
      ['私钥', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
      ['云访问凭据', /\bAKIA[A-Z0-9]{16}\b/g],
    ];
    for (const [rule, re] of patterns)
      for (const match of content.matchAll(re))
        if (!dummy(match[0])) findings.push({ scope, file: name, rule });
    // Secret 无固定前缀，按配置字段识别；通用 secret 还必须有企微机器人上下文。
    const secretFields = /["']?\b(?:wecom[_-]?(?:bot|robot)[_-]?secret|botSecret|robotSecret)["']?\s*[:=]\s*["']?([A-Za-z0-9_+/=-]{16,})/gi;
    const contextual = /wecom|aibot|\bbot[_-]?id\b|企业微信|企微|智能机器人/i.test(name + '\n' + content);
    const genericSecret = /["']?\bsecret["']?\s*[:=]\s*["']?([A-Za-z0-9_+/=-]{16,})/gi;
    for (const re of [secretFields, ...(contextual ? [genericSecret] : [])])
      for (const match of content.matchAll(re))
        if (!placeholder(match[1])) findings.push({ scope, file: name, rule: '企业微信机器人 Secret' });
  };

  const index = git('ls-files', '--stage', '-z').split('\0').filter(Boolean);
  const stagedPaths = new Set(index.map((line) => line.slice(line.indexOf('\t') + 1)));
  for (const path of [fixturePath, 'tests/fixtures/import/README.txt', 'tests/fixtures/import/word-extractor-LICENSE.txt'])
    if (!stagedPaths.has(path)) findings.push({ scope: 'staged', file: path, rule: '发布缺少必需的公开测试夹具或许可证' });
  for (const line of index) {
    const match = /^\d+ ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(line);
    if (!match || match[2] !== '0') throw Error('暂存区存在未解决冲突');
    inspect(match[3], blob(match[1]), 'staged');
  }
  // cached 包含未暂存的当前改动，others 只取未被忽略的新文件；这里读取实际文件。
  const workspace = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))];
  let workingFiles = 0;
  for (const name of workspace) {
    const file = resolve(cwd, name);
    let stat;
    try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) {
      findings.push({ scope: 'working', file: name, rule: '符号链接须人工核对，扫描不跟随链接' });
      continue;
    }
    if (!stat.isFile()) continue;
    workingFiles++;
    // 禁止路径只报路径，不读取其中的运行数据或凭据。
    inspect(name, forbidden.test(name) && name !== fixturePath ? Buffer.alloc(0) : readFileSync(file), 'working');
  }
  const revisions = git('rev-list', '--all').trim();
  if (revisions)
    for (const line of git('rev-list', '--objects', '--all').split('\n')) {
      const match = /^([0-9a-f]+) (.+)$/.exec(line);
      if (match && git('cat-file', '-t', match[1]).trim() === 'blob') inspect(match[2], blob(match[1]), 'history');
    }
  return {
    ok: !findings.length, findings, stagedFiles: index.length, workingFiles,
    history: revisions ? '已逐个检查历史blob' : '无已有提交历史',
    note: '已扫描暂存区、未暂存改动和未被忽略的新文件；规则扫描不能代替人工检查',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = auditRelease();
  (result.ok ? console.log : console.error)(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

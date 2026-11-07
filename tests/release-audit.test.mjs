import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRelease } from '../scripts/release-audit.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('../scripts/release-audit.mjs', import.meta.url));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'erp-release-audit-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '--quiet');
  for (const name of ['word-extractor-test01.doc', 'README.txt', 'word-extractor-LICENSE.txt']) {
    const path = join('tests', 'fixtures', 'import', name);
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    copyFileSync(join(project, path), join(dir, path));
  }
  writeFileSync(join(dir, '.gitignore'), 'ignored/\n');
  writeFileSync(join(dir, 'tracked.txt'), 'safe');
  // 只操作临时测试仓库的暂存区，绝不暂存或提交当前项目。
  git('add', '.');
  return { dir, git, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('发布扫描包含未暂存内容、未跟踪文件和企微 Secret 格式，且输出不带值', () => {
  const f = fixture();
  try {
    assert.equal(auditRelease(f.dir).ok, true);
    const fakeKey = 'sk-' + 'Z'.repeat(32), fakeSecret = 'Q'.repeat(40);
    writeFileSync(join(f.dir, 'tracked.txt'), fakeKey);
    writeFileSync(join(f.dir, 'new-key.txt'), fakeKey);
    writeFileSync(join(f.dir, '未跟踪配置.txt'), 'WECOM_BOT_SECRET=' + fakeSecret);
    writeFileSync(join(f.dir, 'robot-config.json'), JSON.stringify({ provider: 'wecom', secret: fakeSecret }));
    mkdirSync(join(f.dir, 'ignored'));
    writeFileSync(join(f.dir, 'ignored', 'local.txt'), fakeKey);
    const report = auditRelease(f.dir);
    assert.equal(report.ok, false);
    assert.ok(report.findings.some((f) => f.scope === 'working' && f.file === 'tracked.txt' && f.rule === 'API密钥'));
    assert.ok(report.findings.some((f) => f.scope === 'working' && f.file === 'new-key.txt' && f.rule === 'API密钥'));
    assert.ok(report.findings.some((f) => f.scope === 'working' && f.file === '未跟踪配置.txt' && f.rule === '企业微信机器人 Secret'));
    assert.ok(report.findings.some((f) => f.file === 'robot-config.json' && f.rule === '企业微信机器人 Secret'));
    assert.equal(report.findings.some((f) => f.file.startsWith('ignored/')), false);
    const text = JSON.stringify(report);
    assert.equal(text.includes(fakeKey), false);
    assert.equal(text.includes(fakeSecret), false);
    assert.equal(execFileSync('git', ['show', ':tracked.txt'], { cwd: f.dir, encoding: 'utf8' }), 'safe');
    const cli = spawnSync(process.execPath, [script], { cwd: f.dir, encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.ok(JSON.parse(cli.stderr).findings.some((f) => f.file === '未跟踪配置.txt'));
    assert.equal((cli.stdout + cli.stderr).includes(fakeSecret), false);
  } finally { f.close(); }
});

test('发布扫描拒绝 .env 及 .env.*，允许 .env.example；暂存凭据规则仍生效', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, '.env.example'), 'WECOM_BOT_SECRET=your_placeholder_value');
    assert.equal(auditRelease(f.dir).ok, true);
    for (const name of ['.env', '.env.local', '.env.production', '.env.example.local']) writeFileSync(join(f.dir, name), 'placeholder');
    writeFileSync(join(f.dir, 'staged.txt'), 'sk-' + 'R'.repeat(32));
    f.git('add', 'staged.txt');
    const report = auditRelease(f.dir);
    for (const name of ['.env', '.env.local', '.env.production', '.env.example.local'])
      assert.ok(report.findings.some((f) => f.file === name && f.rule.includes('禁止上传')), name);
    assert.equal(report.findings.some((f) => f.file === '.env.example'), false);
    assert.ok(report.findings.some((f) => f.scope === 'staged' && f.file === 'staged.txt' && f.rule === 'API密钥'));
  } finally { f.close(); }
});

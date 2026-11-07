import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, chmodSync, statSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { aesProtector, linuxMasterKey, windowsProtector } from '../server/ai/credential-store.js';
import { configDirectory } from '../server/config-paths.js';
import { Store } from '../server/db.js';
import { createFullBackup, copyAutomaticBackup } from '../server/backup.js';

test('凭据目录按平台选择，Windows保持旧路径，Linux遵守XDG且覆盖项必须绝对路径', () => {
  assert.equal(configDirectory('win32', { LOCALAPPDATA: 'C:\\VirtualLocal' }, 'C:\\VirtualUser'), 'C:\\VirtualLocal\\ZhixuERP');
  assert.equal(configDirectory('win32', {}, 'C:\\VirtualUser'), 'C:\\VirtualUser\\AppData\\Local\\ZhixuERP');
  assert.equal(configDirectory('linux', {}, '/home/virtual'), '/home/virtual/.config/zhixu-erp');
  assert.equal(configDirectory('linux', { XDG_CONFIG_HOME: '/tmp/virtual-config' }, '/home/virtual'), '/tmp/virtual-config/zhixu-erp');
  assert.equal(configDirectory('linux', { ERP_CONFIG_DIR: '/var/lib/virtual/config' }, '/home/virtual'), '/var/lib/virtual/config');
  assert.throws(() => configDirectory('linux', { ERP_CONFIG_DIR: 'relative' }, '/home/virtual'), /绝对路径/);
  assert.throws(() => configDirectory('linux', { XDG_CONFIG_HOME: 'relative' }, '/home/virtual'), /绝对路径/);
});

test('AES带算法版本、随机IV、跨实例可恢复；篡改、错误主密钥和异平台密文拒绝且不泄漏内容', () => {
  const key = randomBytes(32), secret = randomBytes(24).toString('base64');
  try {
    const a = aesProtector(() => Buffer.from(key)), b = aesProtector(() => Buffer.from(key));
    const c = a.protect(secret);
    assert.match(c, /^aes256gcm:v1:/); assert.ok(c !== a.protect(secret));
    assert.ok(b.unprotect(c) === secret); assert.ok(!c.includes(secret));
    const bytes = Buffer.from(c.slice(13), 'base64'); bytes[15] ^= 1;
    for (const run of [() => a.unprotect('aes256gcm:v1:' + bytes.toString('base64')), () => aesProtector(() => randomBytes(32)).unprotect(c), () => a.unprotect('aes256gcm:v1:invalid')])
      assert.throws(run, (e: any) => { assert.equal(e.code, 'storage'); assert.ok(!e.message.includes(secret)); return true; });
    assert.throws(() => a.unprotect('dpapi:v1:virtual-cipher'), /当前平台/);
    assert.throws(() => a.unprotect('legacy-windows-cipher'), /当前平台/);
    assert.throws(() => windowsProtector.unprotect(c), /当前平台/);
  } finally { key.fill(0); }
});

test('Windows DPAPI新标记和旧无标记密文均可恢复', { skip: process.platform !== 'win32' }, () => {
  const secret = randomBytes(24).toString('base64'), c = windowsProtector.protect(secret);
  assert.match(c, /^dpapi:v1:/);
  assert.ok(windowsProtector.unprotect(c) === secret);
  assert.ok(windowsProtector.unprotect(c.slice(9)) === secret);
});

test('Linux原生：创建0700目录和0600主密钥，跨进程恢复且不输出内容', { skip: process.platform !== 'linux' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-key-'));
  try {
    const root = join(dir, 'config'), key = linuxMasterKey(root), digest = createHash('sha256').update(key).digest('hex'); key.fill(0);
    assert.equal(statSync(root).mode & 0o7777, 0o700);
    assert.equal(statSync(join(root, 'credentials')).mode & 0o7777, 0o700);
    assert.equal(statSync(join(root, 'credentials/master.key')).mode & 0o7777, 0o600);
    const script = `import{linuxMasterKey}from'./server/ai/credential-store.ts';import{createHash}from'node:crypto';const k=linuxMasterKey(process.env.KEY_ROOT);if(createHash('sha256').update(k).digest('hex')!==process.env.EXPECTED_DIGEST)process.exitCode=1;k.fill(0);`;
    const p = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { ...process.env, KEY_ROOT: root, EXPECTED_DIGEST: digest }, encoding: 'utf8' });
    assert.equal(p.status, 0); assert.equal(p.stdout, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Linux原生：目录权限、文件权限、符号链接、硬链接及损坏文件均拒绝', { skip: process.platform !== 'linux' }, async () => {
  const { linkSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'erp-key-permissions-'));
  try {
    const root = join(dir, 'config'); linuxMasterKey(root).fill(0);
    const file = join(root, 'credentials/master.key'), original = readFileSync(file);
    chmodSync(file, 0o644); assert.throws(() => linuxMasterKey(root), /0600/); chmodSync(file, 0o600);
    chmodSync(root, 0o755); assert.throws(() => linuxMasterKey(root), /0700/); chmodSync(root, 0o700);
    chmodSync(join(root, 'credentials'), 0o750); assert.throws(() => linuxMasterKey(root), /0700/); chmodSync(join(root, 'credentials'), 0o700);
    const other = join(dir, 'other'); writeFileSync(other, original, { mode: 0o600 }); original.fill(0);
    rmSync(file); symlinkSync(other, file); assert.throws(() => linuxMasterKey(root), /非链接/);
    rmSync(file); linkSync(other, file); assert.throws(() => linuxMasterKey(root), /非链接/);
    rmSync(file); writeFileSync(file, randomBytes(12), { mode: 0o600 }); assert.throws(() => linuxMasterKey(root), /32 字节/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Linux原生：权限错误在启动业务库前拒绝', { skip: process.platform !== 'linux' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-key-startup-'));
  try {
    const config = join(dir, 'config'); mkdirSync(config, { mode: 0o755 }); chmodSync(config, 0o755);
    const db = join(dir, 'must-not-create.sqlite');
    const p = spawnSync(process.execPath, ['--import', 'tsx', resolve('server/index.ts')], { cwd: process.cwd(), env: { ...process.env, ERP_CONFIG_DIR: config, DB_PATH: db, PORT: '32981' }, encoding: 'utf8', timeout: 20000 });
    assert.notEqual(p.status, 0); assert.match(p.stderr, /0700/); assert.equal(existsSync(db), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('完整备份排除误放在业务目录里的主密钥，也拒绝extraFiles指定主密钥', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-key-backup-')), data = join(dir, 'data'); mkdirSync(data);
  const store = new Store(join(data, 'erp.sqlite')); store.close();
  try {
    mkdirSync(join(data, 'credentials')); writeFileSync(join(data, 'credentials/master.key'), randomBytes(32));
    const backup = await createFullBackup({ dataDir: data, backupRoot: join(dir, 'backups') });
    const manifest = JSON.parse(readFileSync(join(backup.dir, 'manifest.json'), 'utf8'));
    assert.ok(manifest.files.every((f: any) => !f.path.includes('master.key')));
    await assert.rejects(createFullBackup({ dataDir: data, backupRoot: join(dir, 'backups'), extraFiles: { 'master.key': join(data, 'credentials/master.key') } }), /主密钥不能进入/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Linux原生：备份复制区分目录大小写，仍拒绝复制回同一目录', { skip: process.platform !== 'linux' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-case-backup-'));
  try {
    const source = join(dir, 'Backup', 'auto-fictional'), target = join(dir, 'backup');
    mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'fictional.txt'), '虚构备份');
    await copyAutomaticBackup(source, target);
    assert.equal(readFileSync(join(target, 'auto-fictional/fictional.txt'), 'utf8'), '虚构备份');
    await assert.rejects(copyAutomaticBackup(source, dirname(source)), /不同/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

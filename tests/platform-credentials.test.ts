// 凭据加密（server/ai/credential-store.ts）：配置目录按平台选、Windows 用 DPAPI、Linux 用 0600 主密钥加 AES；权限不对拒绝启动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, chmodSync, statSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { aesProtector, initializeCredentialProtection, linuxMasterKey, windowsProtector } from '../server/ai/credential-store.js';
import { AiConnectionError } from '../server/ai/errors.js';
import { configDirectory } from '../server/core/index.js';

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
      assert.throws(run, (e: unknown) => {
        assert.ok(e instanceof AiConnectionError);
        assert.equal(e.code, 'storage'); assert.ok(!e.message.includes(secret)); return true;
      });
    assert.throws(() => a.unprotect('dpapi:v1:virtual-cipher'), /当前平台/);
    assert.throws(() => a.unprotect('untagged-cipher'), /当前平台/);
    assert.throws(() => windowsProtector.unprotect(c), /当前平台/);
  } finally { key.fill(0); }
});

test('Windows DPAPI：密文带 dpapi:v1 标记、能解回；不带标记的不认', { skip: process.platform !== 'win32' }, () => {
  const secret = randomBytes(24).toString('base64'), c = windowsProtector.protect(secret);
  assert.match(c, /^dpapi:v1:/);
  assert.ok(windowsProtector.unprotect(c) === secret);
  assert.throws(() => windowsProtector.unprotect(c.slice(9)), /当前平台/);
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

// 启动时最先调它（在打开业务库之前，见 server/index.ts）；这里直接调，不运行 server/index.ts
test('Linux原生：配置目录权限不对，初始化凭据保护就拒绝，报 0700', { skip: process.platform !== 'linux' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-key-startup-')),
    saved = process.env.ERP_CONFIG_DIR;
  try {
    const config = join(dir, 'config');
    mkdirSync(config, { mode: 0o755 });
    chmodSync(config, 0o755);
    process.env.ERP_CONFIG_DIR = config;
    assert.throws(() => initializeCredentialProtection(), /0700/);
  } finally {
    if (saved === undefined) delete process.env.ERP_CONFIG_DIR;
    else process.env.ERP_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

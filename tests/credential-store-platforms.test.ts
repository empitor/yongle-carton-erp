// 凭据加密（server/ai/credential-store.ts）在不对的平台上一律拒绝、不降级为明文；DPAPI 解不开时报中文原因、不清空配置。
// 平台按测试临时换掉 process.platform（同步跑完马上还原），不连网，凭据都是虚构的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiConnectionError } from '../server/ai/errors.js';
import { initializeCredentialProtection, linuxMasterKey, windowsProtector } from '../server/ai/credential-store.js';

/** 在假装的平台上同步跑一段，跑完还原 */
function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!original) throw new Error('取不到 process.platform');
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}
/** 报的是存储类的中文错，带这句原因 */
const storageFailure = (reason: RegExp) => (e: unknown) => e instanceof AiConnectionError && e.code === 'storage' && reason.test(e.message);

test('不是 Windows：DPAPI 加密、解密都拒绝，不降级为明文', () => {
  onPlatform('linux', () => {
    assert.throws(() => windowsProtector.protect('fictional-secret'), storageFailure(/不会降级为明文/));
    assert.throws(() => windowsProtector.unprotect('dpapi:v1:fictional-cipher'), storageFailure(/不会降级为明文/));
  });
});

test('不是 Linux：不读也不建 Linux 主密钥', () => {
  onPlatform('win32', () => assert.throws(() => linuxMasterKey('/fictional/config'), storageFailure(/Linux 主密钥无法安全读取/)));
});

test('Windows、Linux 以外的平台：初始化凭据保护就拒绝启动', () => {
  onPlatform('darwin', () => assert.throws(() => initializeCredentialProtection(), storageFailure(/仅支持 Windows 和 Linux/)));
  onPlatform('win32', () => assert.doesNotThrow(() => initializeCredentialProtection(), 'Windows 用 DPAPI，启动时不用准备主密钥'));
});

test('Windows DPAPI：密文坏了解不开，报中文原因（原配置未清空），不带系统原文', { skip: process.platform !== 'win32' }, () => {
  assert.throws(() => windowsProtector.unprotect('dpapi:v1:' + Buffer.from('fictional-broken-cipher').toString('base64')), storageFailure(/Windows 加密凭据无法读取或保存/));
});

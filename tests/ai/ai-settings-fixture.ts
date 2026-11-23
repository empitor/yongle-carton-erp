// AI 设置测试共用的准备代码：临时目录、指定文件的设置实例（假 DeepSeek、测试加密）、读库里记的版本和那一行。只用虚构数据。
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AiSettingsManager } from '../../server/ai/settings-manager.js';
import { fakeDeepSeek, testProtector } from '../support/fake-deepseek.js';

const storedRow = z.object({ document: z.string() });
const versionRow = z.object({ user_version: z.number() });

/** AI 设置实例：file 不给就是内存库 */
export const settingsAt = (file?: string, fake = fakeDeepSeek()) =>
  new AiSettingsManager({ file, transport: fake.transport, protector: testProtector });

/** 在新建的临时目录里跑 run，跑完删掉（Windows 下文件可能还被占着，删除带重试） */
export async function withTempDir(prefix: string, run: (dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** 设置库文件里记的版本和 ai_settings 那一行的原文（没有这一行是 null） */
export function storedSettings(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const version = versionRow.parse(db.prepare('PRAGMA user_version').get()).user_version;
    const row = db.prepare('SELECT document FROM ai_settings WHERE id=1').get();
    return { version, document: row === undefined ? null : storedRow.parse(row).document };
  } finally {
    db.close();
  }
}

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/* 完整备份目录里的清单（manifest.json）：做备份时写（backup.ts），恢复、列备份时读，都按这一份结构。 */

const MANIFEST_FILE = 'manifest.json';

/** 清单里的一个文件。数据库文件另记版本：业务库记结构版本，其余各记自己的 user_version */
const backupFileSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  bytes: z.number().int().nonnegative(),
  schemaVersion: z.number().int().optional(),
  userVersion: z.number().int().optional(),
});
export type BackupFile = z.output<typeof backupFileSchema>;

const backupManifestSchema = z.object({
  kind: z.literal('erp-full-backup'),
  createdAt: z.string(),
  /** 做备份的程序版本、业务库的结构版本：0.9.0 起才记，0.9.0 以前的备份没有（恢复时由业务库校验按旧备份拒绝） */
  appVersion: z.string().optional(),
  schemaVersion: z.number().int().nullable().optional(),
  /** 业务库比做备份的程序新（补丁回滚后做的备份）：照样备份，记下程序最多支持到第几版 */
  newerSchema: z.literal(true).optional(),
  programSupportsUpTo: z.number().int().optional(),
  files: z.array(backupFileSchema),
});
export type BackupManifest = z.output<typeof backupManifestSchema>;

/** 把清单写进备份目录 */
export function writeBackupManifest(dir: string, manifest: BackupManifest) {
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

/** 读备份目录里的清单：没有、不是 JSON、不合结构都当“不是完整备份目录” */
export function readBackupManifest(dir: string): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'));
  } catch (error) {
    throw new Error('不是完整备份目录。', { cause: error });
  }
  const manifest = backupManifestSchema.safeParse(value);
  if (!manifest.success) throw new Error('不是完整备份目录。', { cause: manifest.error });
  return manifest.data;
}

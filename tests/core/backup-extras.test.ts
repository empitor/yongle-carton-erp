import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { backupExtraFiles } from '../../server/backup-extras.js';

test('完整备份另存 AI 设置与机器人设置的本机配置库', () => {
  const dir = process.env.ERP_CONFIG_DIR;
  assert.ok(dir);
  assert.deepEqual(backupExtraFiles(), {
    'ai-settings.sqlite': join(dir, 'ai', 'settings.sqlite'),
    'bots.sqlite': join(dir, 'bots', 'bots.sqlite'),
  });
});

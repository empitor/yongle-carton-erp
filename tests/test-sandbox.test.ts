// 测试进程碰不到真实数据：跑测试的脚本（scripts/run-tests.mjs）把业务库、备份、配置目录和本机数据目录都指进临时目录，
// 哪条测试忘了传路径，默认位置也都在临时目录下。直接用 node --test 跑单个文件时要自己设这几个环境变量。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import { defaultDbPath } from '../server/core/db.js';
import { backupDirectory, configDirectory } from '../server/core/config-paths.js';
import { defaultAccountPath } from '../server/accounts/index.js';
import { defaultProblemLogPath } from '../server/core/index.js';
import { defaultAiSettingsPath, defaultPromptSettingsPath } from '../server/ai/index.js';
import { defaultAssistantToolsPath } from '../server/assistant/index.js';
import { defaultWorkspaceDirectory } from '../server/import/index.js';
import { defaultBotSettingsPath } from '../server/inbox/index.js';
import { defaultRunLogPath } from '../server/system/index.js';

const inTemp = (path: string) => {
  const rel = relative(tmpdir().toLowerCase(), path.toLowerCase());
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

test('业务库、备份、配置目录、本机数据目录和各个配置库的默认位置都在临时目录下', () => {
  const places: Record<string, string> = {
    业务库: defaultDbPath,
    备份目录: backupDirectory(),
    配置目录: configDirectory(),
    账号库: defaultAccountPath(),
    出错记录库: defaultProblemLogPath(),
    运行日志: defaultRunLogPath(),
    AI设置库: defaultAiSettingsPath(),
    提示词库: defaultPromptSettingsPath(),
    助手工具设置库: defaultAssistantToolsPath(),
    识别工作区: defaultWorkspaceDirectory(),
    机器人设置库: defaultBotSettingsPath(),
    ...(process.platform === 'win32' ? { 本机数据目录: String(process.env.LOCALAPPDATA) } : {}),
  };
  assert.deepEqual(Object.entries(places).filter(([, path]) => !inTemp(path)), []);
});

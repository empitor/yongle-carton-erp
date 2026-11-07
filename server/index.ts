import { Store, defaultDbPath } from './db.js';
import { createApp } from './app.js';
import { acquireLock } from './lock.js';
import { AiSettingsManager } from './ai/settings-manager.js';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { scheduleDailyBackup, snapshotBeforeUpgrade } from './backup.js';
import { defaultAiSettingsPath } from './ai/credential-store.js';
import { ImportManager } from './import/manager.js';
import { fileURLToPath } from 'node:url';
import { AuthManager } from './auth.js';
import { ImportError } from './import/errors.js';
import { AI_HTTP_TIMEOUT_MS } from '../shared/ai-runtime.js';
import { defaultPromptSettingsPath } from './ai/prompt-presets.js';
import { createPromptManagers } from './ai/recognition-modules.js';
import { findImport } from './business/import-execution.js';
import { MarkAi } from './marks/mark-ai.js';
import { ReceiptAi } from './flow/receipt-ai.js';
import { FlowService } from './flow/service.js';
import { defaultAssistantToolsPath } from './assistant/tool-registry.js';
import { AssistantManager } from './assistant/manager.js';
import { localDevelopmentEnabled } from './developer-capability.js';
import { createRuntimeControl } from '../scripts/runtime-control.mjs';
import { createServer } from 'node:http';
import { InboxService } from './inbox/service.js';
import { WecomBotConnection } from './inbox/wecom-bot.js';
import { WecomBotSettings, defaultWecomBotPath } from './inbox/wecom-bot-settings.js';
import { readDeployment } from './deployment.js';
const port = Number(process.env.PORT || 3001);
const deployment = readDeployment(process.env, port);
if (deployment?.backupCopyDir) {
  for (const root of [dirname(defaultDbPath), resolve('backups')]) {
    const path = relative(root, deployment.backupCopyDir);
    if (!path || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)))
      throw new Error('备份复制目录必须位于业务数据和本地备份目录之外。');
  }
}
const unlock = acquireLock(defaultDbPath);
process.on('exit', unlock);
const snapshot = snapshotBeforeUpgrade(defaultDbPath);
if (snapshot) console.log('已生成升级前业务库快照：', snapshot);
const store = new Store();
// 0.8.0 改了“待发货”的判断（做够订单数量才算）。老订单要等下次有单据才重算，
// 所以第一次启动时按新规则全部重算一次；只改状态变了的，跑过就不再跑。失败不挡启动，下次再试。
try {
  const changed = new FlowService(store).recomputeOrderStatusesOnce('produced-enough-2026-11-07');
  if (changed) console.log('已按新规则核对订单状态，有 ' + changed.length + ' 张订单的状态更新。');
} catch (error) {
  console.warn('订单状态重算没有完成，下次启动会再试：' + (error as Error).message);
}
const auth = new AuthManager(join(dirname(defaultDbPath), 'security', 'users.sqlite'), Date.now, {
  localDevelopment: localDevelopmentEnabled(),
  localAdministration: true,
  deployment,
});
const aiSettings = new AiSettingsManager({
  file: defaultAiSettingsPath(),
  legacyFile: join(dirname(defaultDbPath), 'ai-settings.json'),
});
const aiWarning = deployment && aiSettings.credentialWarning();
if (aiWarning) console.warn(aiWarning);
void aiSettings.startup();
const promptManagers = createPromptManagers(dirname(defaultPromptSettingsPath()));
const promptPresets = promptManagers['sales-order'];
const receiptPrompts = promptManagers['supplier-delivery'];
const assistantPrompts = promptManagers['assistant'];
const receiptAi = new ReceiptAi(store, aiSettings, receiptPrompts);
const markAi = new MarkAi(store, aiSettings, promptManagers['shipping-mark']);
const assistant = new AssistantManager(store, aiSettings, assistantPrompts, {
  toolSettingsFile: defaultAssistantToolsPath(),
  disableLocalFeatures: !!deployment,
});
const imports = new ImportManager({
  directory: fileURLToPath(new URL('../data/ai-imports/', import.meta.url)),
  settings: aiSettings,
  promptPresets,
  findImport: (id, hash) => findImport(store, id, hash),
  validateMapping: (m) => {
    if (m.customer.mode === 'existing') {
      const c = store.customer(m.customer.id);
      if (!c || c.version !== m.customer.version)
        throw new ImportError('客户不存在或版本已变化，请重新选择', 409);
    }
    for (const p of Object.values(m.products))
      if (p.mode === 'existing') {
        const product = store.product(p.id);
        if (!product || product.version !== p.version)
          throw new ImportError('产品不存在或版本已变化，请重新选择', 409);
      }
  },
});
const wecomBotSettings = new WecomBotSettings(defaultWecomBotPath());
const botWarning = deployment && wecomBotSettings.credentialWarning();
if (botWarning) console.warn(botWarning);
const inbox = new InboxService(store);
const wecomBot = new WecomBotConnection({
  credentials: () => wecomBotSettings.credentials(),
  ingest: (incoming) => inbox.ingest(incoming),
  exists: (channel, externalId) => inbox.has(channel, externalId),
});
const app = createApp(store, {
    assistant,
    aiSettings,
    promptModules: promptManagers,
    imports,
    auth,
    deployment,
    receiptAi,
    markAi,
    wecomBot: { settings: wecomBotSettings, connection: wecomBot },
    enableReviewedImports: true,
});
const listeners = (deployment ? [port, deployment.proxyPort] : [port]).map((port) => {
  const server = createServer(app);
  server.requestTimeout = AI_HTTP_TIMEOUT_MS;
  server.setTimeout(0); // 响应等待由 AI 绝对期限控制。
  return { server, port };
});
let closing: Promise<void> | undefined;
let stopBackup: (() => void) | undefined;
const shutdown = (notify = true) =>
  (closing ||= (async () => {
    if (notify) process.send?.({ type: 'erp-shutdown' });
    stopBackup?.();
    wecomBot.stop();
    await Promise.all(listeners.map(({ server }) => new Promise<void>((done, reject) => {
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING')
          reject(error);
        else done();
      });
      server.closeIdleConnections();
    })));
    wecomBotSettings.close();
    store.close();
    aiSettings.close();
    imports.close();
    for (const manager of Object.values(promptManagers)) manager.close();
    auth.close();
    unlock();
  })());
const control = await createRuntimeControl(defaultDbPath, shutdown, () => process.exit(0));
try {
  for (const { server, port } of listeners)
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        done();
      });
    });
} catch (error) {
  console.error('服务启动失败：', (error as Error).message);
  await shutdown(false).finally(() => control.close());
  process.exit(1);
}
assistant.connectExtras({
  backup: {
    dataDir: dirname(defaultDbPath),
    backupRoot: resolve('backups'),
    extraFiles: {
      'ai-settings.sqlite': defaultAiSettingsPath(),
      'wecom-bot.sqlite': defaultWecomBotPath(),
    },
  },
});
stopBackup = scheduleDailyBackup({
  dataDir: dirname(defaultDbPath),
  backupRoot: resolve('backups'),
  copyDir: deployment?.backupCopyDir,
  copyKeep: deployment?.backupCopyKeep,
  extraFiles: {
    'ai-settings.sqlite': defaultAiSettingsPath(),
    'wecom-bot.sqlite': defaultWecomBotPath(),
  },
});
console.log(
  `宁波甬勒包装制品有限公司 · 管理系统：http://127.0.0.1:${port}\n数据库：${defaultDbPath}\n` +
  (deployment ? `部署模式，反向代理入口 127.0.0.1:${deployment.proxyPort}` : '本机验收版，正式导入与业务写入需登录管理账号。'),
);
wecomBot.start();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void shutdown()
      .then(() => control.close())
      .then(
        () => process.exit(0),
        (error) => {
          console.error('服务关闭失败：', error.message);
          process.exitCode = 1;
        },
      );
  });

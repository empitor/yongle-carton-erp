import { Store, defaultDbPath } from './db.js';
import { createApp } from './app.js';
import { acquireLock } from './lock.js';
import { AiSettingsManager } from './ai/settings-manager.js';
import { dirname, join } from 'node:path';
import { defaultAiSettingsPath } from './ai/credential-store.js';
import { ImportManager } from './import/manager.js';
import { fileURLToPath } from 'node:url';
import { AuthManager } from './auth.js';
import { ImportError } from './import/errors.js';
import { AI_HTTP_TIMEOUT_MS } from '../shared/ai-runtime.js';
import { defaultPromptSettingsPath } from './ai/prompt-presets.js';
import { createPromptManagers } from './ai/recognition-modules.js';
import { findImport } from './business/import-execution.js';
import { ReceiptAi } from './flow/receipt-ai.js';
import { defaultAssistantToolsPath } from './assistant/tool-registry.js';
import { AssistantManager } from './assistant/manager.js';
import { localDevelopmentEnabled } from './developer-capability.js';
const unlock = acquireLock(defaultDbPath);
process.on('exit', unlock);
const store = new Store();
const auth = new AuthManager(join(dirname(defaultDbPath), 'security', 'users.sqlite'), Date.now, {
  localDevelopment: localDevelopmentEnabled(),
  localAdministration: true,
});
const port = Number(process.env.PORT || 3001);
const aiSettings = new AiSettingsManager({
  file: defaultAiSettingsPath(),
  legacyFile: join(dirname(defaultDbPath), 'ai-settings.json'),
});
void aiSettings.startup();
const promptManagers = createPromptManagers(dirname(defaultPromptSettingsPath()));
const promptPresets = promptManagers['sales-order'];
const receiptPrompts = promptManagers['supplier-delivery'];
const assistantPrompts = promptManagers['assistant'];
const receiptAi = new ReceiptAi(store, aiSettings, receiptPrompts);
const assistant = new AssistantManager(store, aiSettings, assistantPrompts, {
  toolSettingsFile: defaultAssistantToolsPath(),
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
const server = createApp(store, {
  assistant,
  aiSettings,
  promptModules: promptManagers,
  imports,
  auth,
  receiptAi,
  enableReviewedImports: true,
}).listen(port, '127.0.0.1', () =>
  console.log(
    `宁波甬勒包装制品有限公司 · 管理系统：http://127.0.0.1:${port}\n数据库：${defaultDbPath}\n本机验收版，正式导入与业务写入需登录管理账号。`,
  ),
);
server.on('error', (error) => {
  console.error('服务启动失败：', error.message);
  store.close();
  process.exitCode = 1;
});
server.requestTimeout = AI_HTTP_TIMEOUT_MS;
server.setTimeout(0); // 响应等待由AI的600秒绝对期限控制，不再被本机socket空闲超时截断。
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close(() => {
      store.close();
      aiSettings.close();
      imports.close();
      for (const manager of Object.values(promptManagers)) manager.close();
      auth.close();
      process.exit(0);
    });
  });

import { Store, defaultDbPath, type Deployment } from './core/index.js';
import { createApp } from './app.js';
import { acquireLock } from './core/index.js';
import { ProblemLog, defaultProblemLogPath } from './core/index.js';
import { RunLog, captureProcessOutput, defaultRunLogPath, programSource, readLoginRecords } from './system/index.js';
import { AiSettingsManager } from './ai/index.js';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { SchemaError, VersionedSqliteError, scheduleDailyBackup } from './core/index.js';
import { writeSync } from 'node:fs';
import { purgeOperationRequests, scheduleDailyCleanup } from './core/index.js';
import { defaultAiSettingsPath, initializeCredentialProtection } from './ai/index.js';
import { ImportExecutionService, ImportManager, defaultWorkspaceDirectory } from './import/index.js';
import { backupDirectory } from './core/index.js';
import { AuthManager, defaultAccountPath } from './core/index.js';
import { AI_HTTP_TIMEOUT_MS } from '../shared/ai/index.js';
import { DAY_MS, errorMessage } from '../shared/core/index.js';
import { defaultPromptSettingsPath } from './ai/index.js';
import { createPromptManagers } from './ai/index.js';
import { ReceiptAi, defaultPromptPreset, supplierDefaultPreset } from './import/index.js';
import { assistantDefaultPreset, defaultAssistantToolsPath } from './assistant/index.js';
import { AssistantManager } from './assistant/index.js';
import { createRuntimeControl } from '../scripts/runtime-control.mjs';
import { createServer, type Server } from 'node:http';
import { BotSettings, defaultBotSettingsPath, inboxBots, purgeOldInbox } from './inbox/index.js';
import { backupExtraFiles } from './backup-extras.js';
import { readDeployment } from './core/index.js';
import { checkDocumentFonts, purgeExportFiles } from './documents/index.js';
import { DEFAULT_PORT } from './local-service.js';

/**
 * 正式服务的启动入口。只有被直接运行时才启动（npm start、scripts/dev-system.mjs、Linux 的 erp.sh start）：
 * 启动时按 DB_PATH、ERP_CONFIG_DIR（没设时用 LOCALAPPDATA）、PORT 打开真实的业务库和各个配置库、写运行锁、监听端口。
 * 被别的文件 import 时什么都不做，免得“看看能不能加载”的脚本按默认目录起一个正式实例。
 * 要看代码能不能加载，用类型检查，或者加载 server/app.ts 并把数据目录、配置目录指到临时目录。
 */
if (import.meta.main) await startServer();

/** 备份复制目录（部署时另存一份备份的地方）必须在业务数据和本地备份目录之外 */
function checkBackupCopyDir(deployment: Deployment | undefined) {
  if (!deployment?.backupCopyDir) return;
  for (const root of [dirname(defaultDbPath), backupDirectory()]) {
    const path = relative(root, deployment.backupCopyDir);
    if (!path || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)))
      throw new Error('备份复制目录必须位于业务数据和本地备份目录之外。');
  }
}

// 打开业务库和各个配置库：空库新建；旧一些的库先留备份再升级。0.9.0 以前的旧业务库、比程序新的库、
// 不是本系统的文件、认不出格式的配置库、升级失败，都只把提示原样打出来、以非零码退出（不打堆栈），数据不动。
function opening<T>(open: () => T): T {
  try {
    return open();
  } catch (error) {
    if (!(error instanceof SchemaError) && !(error instanceof VersionedSqliteError)) throw error;
    // 同步写完再退出：异步写的话直接退出会把提示截断
    writeSync(2, error.message + '\n');
    process.exit(1);
  }
}

/** 按真实目录打开各个库和服务；助手要用的一次给全 */
function openServices(deployment: Deployment | undefined, runLog: RunLog) {
  const store = opening(() => new Store());
  const problems = opening(() => new ProblemLog(defaultProblemLogPath()));
  const auth = opening(
    () => new AuthManager(defaultAccountPath(), Date.now, { localAdministration: true, deployment }),
  );
  const aiSettings = new AiSettingsManager({ file: defaultAiSettingsPath() });
  const aiWarning = deployment && aiSettings.credentialWarning();
  if (aiWarning) console.warn(aiWarning);
  // 默认提示词由用它的模块提供：订单、送货单识别在识别导入，助手的人设在助手。
  // 这一张表交给识别导入、到货识别、助手和提示词设置页（server/app.ts），各处用的是同一个管理器
  const promptManagers = opening(() =>
    createPromptManagers(dirname(defaultPromptSettingsPath()), {
      'sales-order': defaultPromptPreset,
      'supplier-delivery': supplierDefaultPreset,
      assistant: assistantDefaultPreset,
    }),
  );
  const receiptAi = new ReceiptAi(store, aiSettings, promptManagers['supplier-delivery']);
  const imports = opening(() => new ImportManager({
    directory: defaultWorkspaceDirectory(),
    // 原件归档跟随业务库目录：服务器上程序目录只读，数据在 DB_PATH 所在目录，备份也按这个目录打包。
    archiveDirectory: join(dirname(defaultDbPath), 'import-archive'),
    settings: aiSettings,
    promptPresets: promptManagers['sales-order'],
    store,
    receiptAi,
  }));
  const execution = new ImportExecutionService(store, imports);
  const botSettings = opening(() => new BotSettings(defaultBotSettingsPath()));
  const botWarning = deployment && botSettings.credentialWarning();
  if (botWarning) console.warn(botWarning);
  const bots = inboxBots(store, botSettings);
  const assistant = opening(
    () =>
      new AssistantManager({
        store,
        ai: aiSettings,
        prompts: promptManagers,
        imports,
        execution,
        receiptAi,
        accounts: auth,
        loginRecords: (who, filter) => readLoginRecords(auth.db, who, filter),
        bots,
        deployment: deployment ?? null,
        problems,
        runLog,
        source: programSource(),
        // 助手做的完整备份和每日自动备份同一份目录和附带的配置文件
        backup: { dataDir: dirname(defaultDbPath), backupRoot: backupDirectory(), extraFiles: backupExtraFiles() },
        toolSettingsFile: defaultAssistantToolsPath(),
      }),
  );
  return { store, problems, auth, aiSettings, promptManagers, receiptAi, assistant, imports, execution, botSettings, bots };
}
type Services = ReturnType<typeof openServices>;
type Listener = { server: Server; port: number };

/** 每日清理和定期整理查询统计；返回停掉它们的办法 */
function scheduleUpkeep(store: Store) {
  // 每日清理（启动五分钟后第一次，之后每小时看一次、满 24 小时再清，本机每天关机也能跑到）：
  // 清过期的防重复提交记录、导出文件内容（导出记录本身留着）和没转成单据的收件箱消息，保留天数是各清理函数自己的常量
  // OPERATION_REQUEST_KEEP_DAYS、EXPORT_FILE_KEEP_DAYS、INBOX_KEEP_DAYS；最后把删掉数据后空出来的空间还给磁盘（按页计）。
  // 库正开着事务时整轮跳过，下个小时再看
  const stopCleanup = scheduleDailyCleanup(store, [
    { name: '过期的防重复提交记录', run: () => purgeOperationRequests(store) },
    { name: '过期的导出文件内容', run: () => purgeExportFiles(store) },
    { name: '过期的收件箱消息', run: () => purgeOldInbox(store) },
    { name: '业务库还给磁盘的空间', run: () => store.reclaimSpace(), unit: '页' },
  ]);
  // 连续运行满 24 小时更新一次查询计划用的统计信息（PRAGMA optimize），关闭时 Store 还会再跑一次
  const optimizeTimer = setInterval(() => store.optimize(), DAY_MS);
  optimizeTimer.unref();
  return { stopCleanup, optimizeTimer };
}
type Running = {
  services: Services;
  listeners: Listener[];
  upkeep: ReturnType<typeof scheduleUpkeep> & { stopBackup?: () => void };
  unlock: () => void;
};

function closeServer(server: Server) {
  return new Promise<void>((done, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING')
        reject(error);
      else done();
    });
    server.closeIdleConnections();
  });
}

/** 停掉定时任务和监听，关掉各个库，最后放开运行锁 */
async function closeAll({ services, listeners, upkeep, unlock }: Running, notify: boolean) {
  if (notify) process.send?.({ type: 'erp-shutdown' });
  upkeep.stopBackup?.();
  upkeep.stopCleanup();
  clearInterval(upkeep.optimizeTimer);
  services.bots.stop();
  await Promise.all(listeners.map(({ server }) => closeServer(server)));
  services.botSettings.close();
  services.store.close();
  services.problems.close();
  services.aiSettings.close();
  services.imports.close();
  for (const manager of Object.values(services.promptManagers)) manager.close();
  services.auth.close();
  unlock();
}

async function listenAll(listeners: Listener[]) {
  for (const { server, port } of listeners)
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        done();
      });
    });
}

async function startServer() {
  initializeCredentialProtection();
  checkDocumentFonts();
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const deployment = readDeployment(process.env, port);
  checkBackupCopyDir(deployment);
  const unlock = acquireLock(defaultDbPath);
  process.on('exit', unlock);
  // 运行日志：从这里起服务的输出和报错都另存一份到 logs/run.log，助手和管理员排查时看
  const runLog = new RunLog(defaultRunLogPath());
  captureProcessOutput(runLog);
  const services = openServices(deployment, runLog);
  const { assistant, bots } = services;
  const app = createApp(services.store, {
      assistant,
      aiSettings: services.aiSettings,
      promptModules: services.promptManagers,
      imports: services.imports,
      execution: services.execution,
      auth: services.auth,
      deployment,
      receiptAi: services.receiptAi,
      problems: services.problems,
      bots,
  });
  const listeners = (deployment ? [port, deployment.proxyPort] : [port]).map((port) => {
    const server = createServer(app);
    server.requestTimeout = AI_HTTP_TIMEOUT_MS;
    server.setTimeout(0); // 响应等待由 AI 绝对期限控制。
    return { server, port };
  });
  const running: Running = { services, listeners, upkeep: scheduleUpkeep(services.store), unlock };
  let closing: Promise<void> | undefined;
  const shutdown = (notify = true) => (closing ||= closeAll(running, notify));
  const control = await createRuntimeControl(defaultDbPath, shutdown, () => process.exit(0));
  try {
    await listenAll(listeners);
  } catch (error) {
    console.error('服务启动失败：', errorMessage(error));
    await shutdown(false).finally(() => control.close());
    process.exit(1);
  }
  running.upkeep.stopBackup = scheduleDailyBackup({
    dataDir: dirname(defaultDbPath),
    backupRoot: backupDirectory(),
    copyDir: deployment?.backupCopyDir,
    copyKeep: deployment?.backupCopyKeep,
    extraFiles: backupExtraFiles(),
  });
  console.log(
    `宁波甬勒包装制品有限公司 · 管理系统：http://127.0.0.1:${port}\n数据库：${defaultDbPath}\n` +
    (deployment ? `部署模式，反向代理入口 127.0.0.1:${deployment.proxyPort}` : '本机验收版，正式导入与业务写入需登录管理账号。'),
  );
  bots.start();
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      void shutdown()
        .then(() => control.close())
        .then(
          () => process.exit(0),
          (error: unknown) => {
            console.error('服务关闭失败：', errorMessage(error));
            process.exitCode = 1;
          },
        );
    });
}

// 仅供人工浏览器验收；独立临时库、固定虚构账号和模型替身。
import { createOrderWorkflowFixture } from './assistant-workflow-fixture.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { OperationsService } from '../server/operations/service.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, scryptSync } from 'node:crypto';
import { join, resolve } from 'node:path';
import { today } from '../shared/domain.js';
process.env.PORT = '3196';
const reuse = process.env.ERP_UI_REOPEN === '1';
const f = createOrderWorkflowFixture(
    reuse ? resolve('output/playwright/fictional-ui-upgrade.sqlite') : undefined,
  ),
  authPath = join(f.dir, 'ui-users.sqlite');
const auth = new AuthManager(authPath),
  db = new DatabaseSync(authPath);
db.prepare(
  'INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)',
).run(
  randomUUID(),
  '虚构普通员工',
  'fictional-ui-salt',
  scryptSync('Fictional-Ui-2026', 'fictional-ui-salt', 64).toString('hex'),
  JSON.stringify(['business:edit', 'import:execute']),
  'admin',
);
db.close();
const actor = {
    id: 'fixture-initial',
    name: '虚构期初',
    permissions: ['business:edit'],
    role: 'admin' as const,
  },
  ops = new OperationsService(f.store);
if (!reuse) {
  const raw = ops.saveItem(
    {
      name: '虚构测试纸板',
      kind: 'raw',
      unit: '张',
      length: 1000,
      width: 800,
      dimensionUnit: 'mm',
      material: 'K=A',
      flute: 'BC',
    },
    actor,
  );
  ops.move(
    raw.id,
    {
      action: 'in',
      quantity: '100',
      date: today(),
      notes: '虚构期初，专用于浏览器完工验收',
      acknowledged: true,
      requestId: randomUUID(),
      expectedVersion: raw.version,
    },
    actor,
  );
}
const server = createApp(f.store, {
  auth,
  assistant: f.manager,
  imports: f.imports,
  aiSettings: f.settings,
  enableReviewedImports: true,
  importArchiveDirectory: join(f.dir, 'archive'),
}).listen(3196, '127.0.0.1', () =>
  console.log('虚构浏览器实例 http://127.0.0.1:3196，独立数据目录：' + f.dir),
);
process.on('SIGINT', () =>
  server.close(() => {
    auth.close();
    f.close();
    process.exit(0);
  }),
);

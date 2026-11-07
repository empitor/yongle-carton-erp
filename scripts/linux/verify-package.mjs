// 在解压后的发布包中用包内 Node + --import tsx 运行。所有账号、业务和备份均为临时虚构数据。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import yauzl from 'yauzl';
import ExcelJS from 'exceljs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const marker = JSON.parse(readFileSync(join(root, '.release-package'), 'utf8'));
// 版本号以包里的 package.json 为准，不写死，换版本时不用改这里。
assert.equal(marker.version, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
assert.ok(process.execPath.startsWith(join(root, 'runtime')));
assert.equal(existsSync(join(root, 'data')), false);
assert.equal(existsSync(join(root, 'backups')), false);
const { getSpeechEngine } = await import('../../server/speech/engine.ts');
await assert.rejects(getSpeechEngine(), (error) => error.status === 503 && error.code === 'speech-model');
const dir = mkdtempSync(join(tmpdir(), 'erp-package-check-'));
const data = join(dir, 'fictional-data'); mkdirSync(data);
Object.assign(process.env, {
  LOCALAPPDATA: join(dir, 'localappdata'), ERP_CONFIG_DIR: join(dir, 'config'),
  DB_PATH: join(data, 'erp.sqlite'), ERP_BACKUP_DIR: join(dir, 'fictional-backups'),
  ERP_ENV_FILE: join(dir, 'absent.env'), ERP_NO_BROWSER: '1', NODE_ENV: 'production',
  ERP_DEPLOYMENT: '0', ERP_BACKUP_COPY_DIR: '',
});
const { Store } = await import('../../server/db.ts');
const { OperationsService } = await import('../../server/operations/service.ts');
const { FlowService } = await import('../../server/flow/service.ts');
const { customerSchema, productSchema, orderSchema } = await import('../../shared/domain.ts');
const store = new Store(), ops = new OperationsService(store), flow = new FlowService(store);
const actor = { id: 'fictional-package-check', name: '虚构安装包验收', role: 'admin', permissions: ['business:edit'] };
const supplier = ops.saveSupplier({ name: '虚构供应商', contact: '', phone: '', address: '' }, actor);
const raw = ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张', specification: '虚构规格' }, actor);
const purchase = ops.savePurchase({ supplierId: supplier.id, orderDate: '2026-11-07', status: '待订货', lines: [{ ...raw, stockItemId: raw.id, quantity: '10', unitPrice: '1.2345' }] }, actor);
const customer = store.saveCustomer(customerSchema.parse({ name: '虚构客户' }));
const product = store.saveProduct(productSchema.parse({ name: '虚构纸箱', length: 300, width: 200, height: 100 }));
const stock = ops.saveItem({ name: '虚构纸箱', kind: 'finished', unit: '只', productId: product.id }, actor);
const order = store.saveOrder(orderSchema.parse({ customerId: customer.id, orderDate: '2026-11-07', deliveryDate: '2026-11-08', status: '已确认', lines: [{ productId: product.id, productName: product.name, specification: '', quantity: 10, unit: '只', unitPriceCents: 100 }] }));
const delivery = flow.save('delivery', { date: '2026-11-07', customerId: customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: stock.id, quantity: '2' }] }, actor);
store.close();
const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port; await new Promise((r) => socket.close(r));
assert.notEqual(port, 3001); process.env.PORT = String(port);
const origin = `http://127.0.0.1:${port}`;
const run = (action, ...args) => process.platform === 'linux'
  ? spawnSync('sh', [join(root, 'scripts/linux/erp.sh'), action, ...args], { cwd: root, env: process.env, encoding: 'utf8', timeout: 30000 })
  : spawnSync(process.execPath, ['--import', 'tsx', join(root, action === 'stop' ? 'server/stop.ts' : 'server/maintenance.ts'), ...(action === 'stop' ? [] : [action, ...args])], { cwd: root, env: process.env, encoding: 'utf8', timeout: 30000 });
const child = process.platform === 'linux'
  ? spawn('sh', [join(root, 'scripts/linux/erp.sh'), 'start'], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(process.execPath, [join(root, 'scripts/start-system.mjs')], { cwd: root, env: { ...process.env, PATH: dirname(process.execPath) + ';' + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
const closed = once(child, 'close');
let log = ''; child.stdout.on('data', (b) => log += b); child.stderr.on('data', (b) => log += b);
const unzip = (bytes) => new Promise((resolve, reject) => {
  const entries = new Map();
  yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    zip.on('error', reject); zip.on('end', () => resolve(entries));
    zip.on('entry', (e) => zip.openReadStream(e, (error, stream) => {
      if (error) return reject(error);
      const chunks = []; stream.on('data', (b) => chunks.push(b)); stream.on('error', reject);
      stream.on('end', () => { entries.set(e.fileName, Buffer.concat(chunks).toString()); zip.readEntry(); });
    })); zip.readEntry();
  });
});
try {
  let state;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('隔离服务提前退出：' + log);
    try { const r = await fetch(origin + '/api/auth/state'); if (r.ok) { state = await r.json(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.ok(state, '隔离服务启动超时：' + log);
  assert.equal(state.configured, false);
  assert.equal((await fetch(origin + '/')).status, 200);
  let headers = { 'Content-Type': 'application/json', Origin: origin, 'x-erp-auth-token': state.csrf };
  const password = 'Fictional-' + randomBytes(18).toString('hex');
  const setup = await fetch(origin + '/api/auth/setup', { method: 'POST', headers, body: JSON.stringify({ name: '虚构安装包管理员', password }) });
  assert.equal(setup.status, 200, await setup.clone().text());
  headers.cookie = setup.headers.get('set-cookie').split(';')[0];
  state = await (await fetch(origin + '/api/auth/state', { headers })).json();
  assert.equal(state.actor.name, '虚构安装包管理员'); headers['x-erp-auth-token'] = state.csrf;
  const outputs = [];
  for (const [kind, record, count] of [['purchase', purchase, 24], ['delivery', delivery, 6]]) {
    const preview = await (await fetch(origin + `/api/documents/preview/${kind}/${record.id}`, { headers })).json();
    assert.equal(preview.rowsPerPage, count);
    for (const format of ['docx', 'xlsx']) {
      const response = await fetch(origin + '/api/documents', { method: 'POST', headers, body: JSON.stringify({ kind, id: record.id, format, expectedVersion: record.version, requestId: randomUUID() }) });
      assert.equal(response.status, 200, await response.clone().text());
      const file = await response.json();
      const download = await fetch(origin + file.url, { headers }); assert.equal(download.status, 200);
      const bytes = Buffer.from(await download.arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
      writeFileSync(join(dir, `${kind}.${format}`), bytes);
      if (format === 'docx') {
        const xml = (await unzip(bytes)).get('word/document.xml');
        const table = [...xml.matchAll(/<w:tbl>.*?<\/w:tbl>/gs)].map((m) => m[0]).find((t) => t.includes('<w:tblHeader/>'));
        assert.equal([...table.matchAll(/<w:tr[ >].*?<\/w:tr>/gs)].length, count + 2 + (preview.total !== undefined ? 1 : 0));
        assert.match(xml, /虚构/);
      } else {
        const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes);
        const sheet = book.worksheets[0], header = sheet.getRows(1, sheet.rowCount).find((r) => r.getCell(2).value === '产品名称');
        assert.ok(header); assert.equal(sheet.getRow(header.number + count + 1 + (preview.total !== undefined ? 1 : 0)).getCell(1).value, '备注');
      }
      outputs.push(`${kind}.${format}: ${count} 行`);
    }
  }
  const backup = run('backup'); assert.equal(backup.status, 0, backup.stderr);
  const backups = readdirSync(process.env.ERP_BACKUP_DIR); assert.equal(backups.length, 1);
  const backupPath = join(process.env.ERP_BACKUP_DIR, backups[0]);
  assert.ok(!readFileSync(join(backupPath, 'manifest.json'), 'utf8').includes('master.key'));
  const stop = run('stop'); assert.equal(stop.status, 0, stop.stderr); await closed;
  const restore = run('restore', backupPath); assert.equal(restore.status, 0, restore.stderr);
  // 捕获并丢弃 CLI 的一次性临时密码，不打印或写入日志。
  const reset = run('reset-password', '虚构安装包管理员'); assert.equal(reset.status, 0); reset.stdout = '';
  assert.equal(existsSync(join(root, 'data')), false); assert.equal(existsSync(join(root, 'backups')), false);
  console.log(JSON.stringify({ platform: process.platform, node: process.version, marker, start: 'ok', login: 'ok', outputs, backup: 'ok', stop: 'ok', restore: 'ok', resetPassword: 'ok', directory: dir }, null, 2));
} finally {
  if (child.exitCode === null && child.signalCode === null) { run('stop'); await closed; }
}

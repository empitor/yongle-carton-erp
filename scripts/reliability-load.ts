import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../server/db.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { today } from '../shared/domain.js';
import { adjacentPeriod } from '../server/finance/query.js';

const dir = mkdtempSync(join(tmpdir(), 'erp-finance-load-'));
process.env.LOCALAPPDATA = dir;
const store = new Store(join(dir, 'erp.sqlite'));
const auth = new AuthManager(':memory:');
const server = createServer(createApp(store, { auth }));
const period = today().slice(0, 7);
const start = adjacentPeriod(period, -11);
const posted = process.argv.includes('--posted');
const seq = (n: number) =>
  `WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<${n})`;
const offset = "date(?,printf('+%d months',n%12),printf('+%d days',n%27))";

try {
  store.db.exec(`BEGIN;
    INSERT INTO customers(id,name,contact,phone,address,notes,created_at) VALUES(1,'虚构压测客户','','','','','2025-01-01');
    INSERT INTO suppliers(id,name,contact,phone,address,notes,created_at) VALUES(1,'虚构压测供应商','','','','','2025-01-01');
    INSERT INTO stock_items(id,name,kind,unit,document,created_at)
      VALUES(1,'虚构纸板','raw','张','{"name":"虚构纸板","kind":"raw","unit":"张"}','2025-01-01');
    INSERT INTO fin_cash_accounts(id,name,kind,account_code) VALUES(1,'虚构银行','bank','1002');
    ${seq(200000)} INSERT INTO stock_movements(id,item_id,action,delta_units,before_units,after_units,source_kind,date,notes,actor_id,actor_name,created_at)
      SELECT 'bench-'||n,1,'in',10000,(n-1)*10000,n*10000,'manual','2025-01-01','','benchmark','压测','2025-01-01' FROM seq;
    ${seq(5000)} INSERT INTO inbox_items(channel,external_id,kind,text,received_at,created_at)
      SELECT 'manual','bench-'||n,'text','虚构收件','2025-01-01','2025-01-01' FROM seq;`);
  store.db
    .prepare(
      `${seq(50000)} INSERT INTO flow_documents(kind,number,date,status,document,actor_id,actor_name,created_at,updated_at)
    SELECT CASE WHEN n%2=0 THEN 'delivery' ELSE 'arrival' END, 'bench-'||n,${offset},'confirmed',
      CASE WHEN n%2=0 THEN
        '{"customerId":1,"customerName":"虚构压测客户","lines":[{"stockId":1,"productName":"虚构箱","quantity":"1","unit":"只","unitPriceExact":"2","amountExact":"2","taxMode":"未税","taxRate":"0"}]}'
      ELSE '{"supplierId":1,"supplierName":"虚构压测供应商","lines":[{"stockId":1,"item":{"name":"虚构板","unit":"张"},"quantity":"1","stockedQuantity":"1","unitPrice":"1","priceBasis":"quantity","amountExact":"1","taxMode":"未税","taxRate":"0"}]}' END,
      'benchmark','压测','2025-01-01','2025-01-01' FROM seq`,
    )
    .run(start + '-01');
  store.db.exec(`INSERT INTO flow_refs(document_id,customer_id,supplier_id,stock_id)
    SELECT id,CASE WHEN kind='delivery' THEN 1 END,CASE WHEN kind='arrival' THEN 1 END,1 FROM flow_documents;`);
  store.db
    .prepare(
      `${seq(10000)} INSERT INTO fin_cash_documents(kind,account_id,party_id,party_name,date,amount_cents,method,description,status)
    SELECT CASE WHEN n%2=0 THEN 'receipt' ELSE 'payment' END,1,'1','虚构往来',${offset},200,'银行','虚构资金','confirmed' FROM seq`,
    )
    .run(start + '-01');
  store.db.exec('COMMIT;');
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('压测监听失败');
  const base = `http://127.0.0.1:${address.port}/api`;
  let cookie = '';
  async function call(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + path, {
      method,
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-erp-auth-token': auth.csrf,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`${response.status} ${path} ${JSON.stringify(value)}`);
    return { response, value };
  }
  const login = await call('/auth/setup', 'POST', {
    name: '虚构压测用户',
    password: 'Fictional-load-password',
  });
  cookie = login.response.headers.get('set-cookie')!.split(';')[0];
  await call('/finance/opening/enable', 'POST', {
    requestId: randomUUID(),
    version: 1,
    period: start,
    taxpayer: 'general',
    rows: [],
  });
  if (posted) {
    // 加密集往来、记账分录及分期，避免把空台账上的响应当作容量结果。
    store.db.exec(`BEGIN;
      INSERT OR IGNORE INTO fin_periods(period,status) SELECT DISTINCT substr(date,1,7),'open' FROM flow_documents;
      INSERT INTO fin_events(id,source_kind,source_id,event_type,source_version,source_hash,date,amount_cents,snapshot,status)
        SELECT id,kind,cast(id AS TEXT),kind||'.confirmed',version,'benchmark',date,
          CASE kind WHEN 'delivery' THEN 200 ELSE 100 END,
          json_object('doc',json(document),'theoretical',json_object('gross',CASE kind WHEN 'delivery' THEN 200 ELSE 100 END)),
          'generated' FROM flow_documents WHERE id%4 IN (0,1);
      INSERT INTO fin_source_observations SELECT source_kind,source_id,source_version,'confirmed',id FROM fin_events;
      INSERT INTO fin_vouchers(id,number,date,period,description,attachment_count,event_id,status,maker_id,maker_name,created_at)
        SELECT id,id,date,substr(date,1,7),'虚构来源凭证',0,id,'posted','benchmark','压测',date FROM fin_events;
      UPDATE fin_events SET voucher_id=id;
      INSERT INTO fin_obligations(id,kind,party_id,party_name,date,due_date,amount_cents,description,event_id,voucher_id)
        SELECT id,CASE source_kind WHEN 'delivery' THEN 'receivable' ELSE 'payable' END,'1',
          CASE source_kind WHEN 'delivery' THEN '虚构压测客户' ELSE '虚构压测供应商' END,
          date,date(date,'+30 days'),amount_cents,'虚构货款',id,id FROM fin_events;
      INSERT INTO fin_entries(voucher_id,position,account_code,description,debit,credit,auxiliary_kind,auxiliary_id,auxiliary_name)
        SELECT id,1,CASE kind WHEN 'receivable' THEN '1122' ELSE '1403' END,'虚构货款',amount_cents,0,
          CASE kind WHEN 'receivable' THEN 'customer' END, CASE kind WHEN 'receivable' THEN '1' END,
          CASE kind WHEN 'receivable' THEN party_name END FROM fin_obligations
        UNION ALL SELECT id,2,CASE kind WHEN 'receivable' THEN '5001' ELSE '2202' END,'虚构货款',0,amount_cents,
          CASE kind WHEN 'payable' THEN 'supplier' END, CASE kind WHEN 'payable' THEN '1' END,
          CASE kind WHEN 'payable' THEN party_name END FROM fin_obligations;
      INSERT INTO fin_installments(obligation_id,position,due_date,amount_cents)
        SELECT id,1,date(date,'+15 days'),amount_cents/2 FROM fin_obligations WHERE id%16<4
        UNION ALL SELECT id,2,date(date,'+45 days'),amount_cents-amount_cents/2 FROM fin_obligations WHERE id%16<4;
      INSERT INTO fin_vouchers(id,number,date,period,description,attachment_count,status,maker_id,maker_name,created_at,module_source,module_id)
        SELECT 50000+c.id,50000+c.id,c.date,substr(c.date,1,7),'虚构资金凭证',0,'posted','benchmark','压测',c.date,'cash',c.id
          FROM fin_cash_documents c;
      INSERT INTO fin_entries(voucher_id,position,account_code,description,debit,credit,cash_flow)
        SELECT 50000+id,1,'1002','虚构收付',CASE kind WHEN 'receipt' THEN amount_cents ELSE 0 END,
          CASE kind WHEN 'payment' THEN amount_cents ELSE 0 END,
          CASE kind WHEN 'receipt' THEN '销售商品收到的现金' ELSE '购买商品支付的现金' END FROM fin_cash_documents;
      INSERT INTO fin_entries(voucher_id,position,account_code,description,debit,credit,auxiliary_kind,auxiliary_id,auxiliary_name)
        SELECT 50000+id,2,CASE kind WHEN 'receipt' THEN '2203' ELSE '1123' END,'虚构预收预付',
          CASE kind WHEN 'payment' THEN amount_cents ELSE 0 END,
          CASE kind WHEN 'receipt' THEN amount_cents ELSE 0 END,
          CASE kind WHEN 'receipt' THEN 'customer' ELSE 'supplier' END,'1',party_name FROM fin_cash_documents;
      UPDATE fin_cash_documents SET voucher_id=50000+id;
      COMMIT;`);
  }
  const repetitions = Number(process.env.ERP_LOAD_RUNS || 3);
  if (!Number.isSafeInteger(repetitions) || repetitions < 1)
    throw new Error('ERP_LOAD_RUNS 应为正整数');
  console.log(
    JSON.stringify({
      counts: {
        flow: 50000,
        cash: 10000,
        movements: 200000,
        inbox: 5000,
        postedObligations: posted ? 25000 : 0,
      },
      period,
      start,
      repetitions,
    }),
  );
  for (const route of [
    'monthly-report',
    'monthly-report/trend',
    'flow',
    'obligations',
    'aging',
    'held',
    'payment-plan',
    'reports/readiness',
    'closing',
    'events/sync',
    '/inbox',
    '/business/today',
  ]) {
    const path =
      (route.startsWith('/') ? route : '/finance/' + route) +
      `?period=${period}&date=${period}-28&kind=receivable`;
    const ms = [];
    let last: unknown;
    for (let i = 0; i < repetitions; i++) {
      const startTime = performance.now();
      last = (
        await (route === 'events/sync'
          ? call(path, 'POST', { requestId: randomUUID() })
          : call(path))
      ).value;
      ms.push(Math.round(performance.now() - startTime));
    }
    console.log(JSON.stringify({ route, ms, ...(route === 'events/sync' ? { last } : {}) }));
  }
} finally {
  await new Promise<void>((done) => server.close(() => done()));
  auth.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

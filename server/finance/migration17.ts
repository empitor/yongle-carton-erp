import type { DatabaseSync } from 'node:sqlite';

export function migrateFinance17(db: DatabaseSync) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=17').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=17').get()) {
      db.exec('COMMIT');
      return;
    }
    db.exec(`
      ALTER TABLE fin_party_terms ADD COLUMN tax_rate TEXT;
      ALTER TABLE fin_party_terms ADD COLUMN tax_mode TEXT;
      ALTER TABLE fin_party_terms ADD COLUMN term_type TEXT NOT NULL DEFAULT 'days';
      ALTER TABLE fin_party_terms ADD COLUMN term_months INTEGER;
      ALTER TABLE fin_party_terms ADD COLUMN payment_day INTEGER;
      ALTER TABLE fin_party_terms ADD COLUMN cutoff_day INTEGER;
      ALTER TABLE fin_party_terms ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE fin_obligations RENAME TO fin_obligations_v16;
      CREATE TABLE fin_obligations (
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('receivable','payable')),
        party_id TEXT NOT NULL, party_name TEXT NOT NULL, date TEXT NOT NULL, due_date TEXT,
        amount_cents INTEGER NOT NULL, description TEXT NOT NULL, event_id INTEGER REFERENCES fin_events(id),
        voucher_id INTEGER REFERENCES fin_vouchers(id), version INTEGER NOT NULL DEFAULT 1,
        tax_status TEXT NOT NULL DEFAULT 'known', reversal_of INTEGER REFERENCES fin_obligations(id),
        opening_id INTEGER REFERENCES fin_opening(id), terms_snapshot TEXT,
        estimate_voucher_id INTEGER REFERENCES fin_vouchers(id), estimate_remaining INTEGER
      ) STRICT;
      INSERT INTO fin_obligations(id,kind,party_id,party_name,date,due_date,amount_cents,description,event_id,voucher_id,version)
        SELECT id,kind,party_id,party_name,date,due_date,amount_cents,description,event_id,voucher_id,version FROM fin_obligations_v16;
      DROP TABLE fin_obligations_v16;
      CREATE INDEX fin_obligations_party ON fin_obligations(kind,party_id,date);
      CREATE INDEX fin_obligations_event ON fin_obligations(event_id);
      CREATE UNIQUE INDEX fin_obligation_opening ON fin_obligations(opening_id) WHERE opening_id IS NOT NULL;
      ALTER TABLE fin_vouchers ADD COLUMN module_source TEXT;
      ALTER TABLE fin_vouchers ADD COLUMN module_id INTEGER;
      CREATE INDEX fin_voucher_module ON fin_vouchers(module_source,module_id);
      CREATE TABLE fin_cash_accounts(
        id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        account_code TEXT NOT NULL UNIQUE REFERENCES fin_accounts(code), last_four TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE TABLE fin_cash_documents(
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES fin_cash_accounts(id),
        target_account_id INTEGER REFERENCES fin_cash_accounts(id), party_id TEXT, party_name TEXT,
        date TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0), method TEXT NOT NULL,
        description TEXT NOT NULL, counter_account TEXT, cash_flow TEXT, voucher_id INTEGER REFERENCES fin_vouchers(id),
        status TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE INDEX fin_cash_account_date ON fin_cash_documents(account_id,date);
      CREATE TABLE fin_allocations(
        id INTEGER PRIMARY KEY, cash_id INTEGER NOT NULL REFERENCES fin_cash_documents(id),
        obligation_id INTEGER NOT NULL REFERENCES fin_obligations(id), date TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK(amount_cents<>0), voucher_id INTEGER NOT NULL REFERENCES fin_vouchers(id),
        initial INTEGER NOT NULL DEFAULT 0, reversal_of INTEGER REFERENCES fin_allocations(id),
        status TEXT NOT NULL DEFAULT 'active', version INTEGER NOT NULL DEFAULT 1,
        discount_cents INTEGER NOT NULL DEFAULT 0, discount_reason TEXT
      ) STRICT;
      CREATE INDEX fin_alloc_obligation ON fin_allocations(obligation_id,date);
      CREATE INDEX fin_alloc_cash ON fin_allocations(cash_id,date);
      CREATE UNIQUE INDEX fin_alloc_reversal ON fin_allocations(reversal_of) WHERE reversal_of IS NOT NULL;
      CREATE TABLE fin_installments(
        id INTEGER PRIMARY KEY, obligation_id INTEGER NOT NULL REFERENCES fin_obligations(id),
        position INTEGER NOT NULL, due_date TEXT, amount_cents INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, UNIQUE(obligation_id,position)
      ) STRICT;
      CREATE TABLE fin_deposits(
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, party_kind TEXT NOT NULL, party_id TEXT NOT NULL, party_name TEXT NOT NULL,
        date TEXT NOT NULL, amount_cents INTEGER NOT NULL, description TEXT NOT NULL, voucher_id INTEGER REFERENCES fin_vouchers(id),
        version INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE TABLE fin_deposit_actions(
        id INTEGER PRIMARY KEY, deposit_id INTEGER NOT NULL REFERENCES fin_deposits(id), kind TEXT NOT NULL, date TEXT NOT NULL,
        amount_cents INTEGER NOT NULL, obligation_id INTEGER REFERENCES fin_obligations(id), voucher_id INTEGER REFERENCES fin_vouchers(id)
      ) STRICT;
      CREATE TABLE fin_interest(
        id INTEGER PRIMARY KEY, obligation_id INTEGER NOT NULL REFERENCES fin_obligations(id), period TEXT NOT NULL,
        date TEXT NOT NULL, amount_cents INTEGER NOT NULL, reason TEXT NOT NULL, voucher_id INTEGER REFERENCES fin_vouchers(id),
        version INTEGER NOT NULL DEFAULT 1, UNIQUE(obligation_id,period)
      ) STRICT;
      CREATE TABLE fin_bad_debts(
        id INTEGER PRIMARY KEY, obligation_id INTEGER NOT NULL REFERENCES fin_obligations(id),
        kind TEXT NOT NULL, date TEXT NOT NULL, amount_cents INTEGER NOT NULL, reason TEXT NOT NULL,
        voucher_id INTEGER NOT NULL REFERENCES fin_vouchers(id)
      ) STRICT;
      CREATE TABLE fin_statements(
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, party_id TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL,
        status TEXT NOT NULL, discrepancy TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        UNIQUE(kind,party_id,from_date,to_date)
      ) STRICT;
      CREATE TABLE fin_mapping_profiles(
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, mapping TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, UNIQUE(kind,name)
      ) STRICT;
      CREATE TABLE fin_bank_rows(
        id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES fin_cash_accounts(id),
        date TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents<>0), reference TEXT,
        party_name TEXT NOT NULL, description TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
        voucher_id INTEGER REFERENCES fin_vouchers(id), entry_position INTEGER,
        version INTEGER NOT NULL DEFAULT 1, UNIQUE(voucher_id,entry_position)
      ) STRICT;
      CREATE INDEX fin_bank_date ON fin_bank_rows(account_id,date);
      CREATE TABLE fin_bank_matches(
        bank_id INTEGER NOT NULL REFERENCES fin_bank_rows(id),
        voucher_id INTEGER NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY(bank_id,voucher_id,position), UNIQUE(voucher_id,position),
        FOREIGN KEY(voucher_id,position) REFERENCES fin_entries(voucher_id,position)
      ) STRICT;
      CREATE TABLE fin_notes(
        id INTEGER PRIMARY KEY, number TEXT NOT NULL, kind TEXT NOT NULL, bank TEXT NOT NULL, party_id TEXT NOT NULL,
        party_name TEXT NOT NULL, date TEXT NOT NULL, due_date TEXT NOT NULL, amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL, voucher_id INTEGER REFERENCES fin_vouchers(id), version INTEGER NOT NULL DEFAULT 1,
        UNIQUE(kind,number)
      ) STRICT;
      CREATE TABLE fin_attachments(
        id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, media_type TEXT NOT NULL,
        bytes BLOB NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE fin_invoices(
        id INTEGER PRIMARY KEY, direction TEXT NOT NULL, type TEXT NOT NULL, number TEXT NOT NULL, date TEXT NOT NULL,
        party_id TEXT NOT NULL, party_name TEXT NOT NULL, tax_id TEXT NOT NULL, net INTEGER NOT NULL,
        rate TEXT NOT NULL, tax INTEGER NOT NULL, gross INTEGER NOT NULL, status TEXT NOT NULL,
        original_id INTEGER REFERENCES fin_invoices(id), voucher_id INTEGER REFERENCES fin_vouchers(id),
        transfer_voucher_id INTEGER REFERENCES fin_vouchers(id), attachment_id INTEGER REFERENCES fin_attachments(id),
        version INTEGER NOT NULL DEFAULT 1, UNIQUE(type,number)
      ) STRICT;
      CREATE INDEX fin_invoice_date ON fin_invoices(direction,date);
      CREATE TABLE fin_invoice_links(
        invoice_id INTEGER NOT NULL REFERENCES fin_invoices(id), obligation_id INTEGER NOT NULL REFERENCES fin_obligations(id),
        amount_cents INTEGER NOT NULL, estimate_cents INTEGER, net_cents INTEGER, quantity_units INTEGER, unit TEXT,
        PRIMARY KEY(invoice_id,obligation_id)
      ) STRICT;
      CREATE TABLE fin_expenses(
        id INTEGER PRIMARY KEY, employee_id TEXT NOT NULL, employee_name TEXT NOT NULL, department TEXT NOT NULL,
        date TEXT NOT NULL, account_code TEXT NOT NULL REFERENCES fin_accounts(code), amount_cents INTEGER NOT NULL,
        description TEXT NOT NULL, status TEXT NOT NULL, invoice_id INTEGER REFERENCES fin_invoices(id),
        attachment_id INTEGER REFERENCES fin_attachments(id), voucher_id INTEGER REFERENCES fin_vouchers(id),
        cash_id INTEGER REFERENCES fin_cash_documents(id), version INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE TABLE fin_assets(
        id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT NOT NULL,
        original_cents INTEGER NOT NULL, date TEXT NOT NULL, months INTEGER NOT NULL, residual_bp INTEGER NOT NULL,
        department TEXT NOT NULL, expense_account TEXT NOT NULL REFERENCES fin_accounts(code), status TEXT NOT NULL,
        voucher_id INTEGER REFERENCES fin_vouchers(id), version INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE TABLE fin_depreciation(
        asset_id INTEGER NOT NULL REFERENCES fin_assets(id), period TEXT NOT NULL, amount_cents INTEGER NOT NULL,
        voucher_id INTEGER NOT NULL REFERENCES fin_vouchers(id), PRIMARY KEY(asset_id,period)
      ) STRICT;
      CREATE TABLE fin_payroll(
        id INTEGER PRIMARY KEY, period TEXT NOT NULL, employee_id TEXT NOT NULL, employee_name TEXT NOT NULL,
        department TEXT NOT NULL, account_code TEXT NOT NULL REFERENCES fin_accounts(code),
        gross INTEGER NOT NULL, social INTEGER NOT NULL, housing INTEGER NOT NULL, tax INTEGER NOT NULL,
        net INTEGER NOT NULL, employer_social INTEGER NOT NULL, employer_housing INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, UNIQUE(period,employee_id)
      ) STRICT;
      CREATE TABLE fin_inventory_costs(
        stock_id INTEGER NOT NULL, period TEXT NOT NULL, stock_name TEXT NOT NULL, unit TEXT NOT NULL,
        opening_qty INTEGER NOT NULL, opening_cents INTEGER NOT NULL, in_qty INTEGER NOT NULL, in_cents INTEGER NOT NULL,
        out_qty INTEGER NOT NULL, out_cents INTEGER NOT NULL, end_qty INTEGER NOT NULL, end_cents INTEGER NOT NULL,
        PRIMARY KEY(stock_id,period)
      ) STRICT;
      CREATE TABLE fin_cost_sales(
        period TEXT NOT NULL, movement_id TEXT NOT NULL, order_id INTEGER, customer_id INTEGER, product_id INTEGER,
        cost_cents INTEGER NOT NULL, PRIMARY KEY(period,movement_id)
      ) STRICT;
      CREATE TABLE fin_period_jobs(
        period TEXT NOT NULL, kind TEXT NOT NULL, voucher_id INTEGER REFERENCES fin_vouchers(id),
        details TEXT NOT NULL, PRIMARY KEY(period,kind)
      ) STRICT;
      CREATE TABLE fin_report_snapshots(
        period TEXT NOT NULL REFERENCES fin_periods(period), version INTEGER NOT NULL, document TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(period,version)
      ) STRICT;
      CREATE TABLE fin_budgets(
        period TEXT NOT NULL, account_code TEXT NOT NULL REFERENCES fin_accounts(code), amount_cents INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(period,account_code)
      ) STRICT;
      INSERT INTO fin_obligations(kind,party_id,party_name,date,amount_cents,description,opening_id)
        SELECT CASE WHEN account_code LIKE '1122%' THEN 'receivable' ELSE 'payable' END,
          auxiliary_id,auxiliary_name,start_period||'-01',
          CASE WHEN account_code LIKE '1122%' THEN debit-credit ELSE credit-debit END,'期初往来',o.id
        FROM fin_opening o CROSS JOIN fin_settings WHERE start_period IS NOT NULL AND auxiliary_id IS NOT NULL
        AND debit<>credit AND (account_code LIKE '1122%' OR account_code LIKE '2202%');
      UPDATE fin_events SET status='info_pending',
        snapshot=json_set(snapshot,'$.missing',json_array(CASE WHEN problem LIKE '%价%' THEN 'price'
          WHEN problem LIKE '%数量%' OR problem LIKE '%单位%' THEN 'quantity' ELSE 'tax' END))
        WHERE status='blocked';
      UPDATE fin_source_observations SET status='refresh'
        WHERE event_id IN (SELECT id FROM fin_events WHERE status='info_pending');
      INSERT INTO fin_templates(name,mapping) VALUES
        ('settlement.discount','{"fee":"5603"}'),('deposit','{"paid":"1221","received":"2241"}'),
        ('interest','{"fee":"5603"}'),('notes','{"receivable":"1121","payable":"2201"}'),
        ('bad_debt','{"expense":"5711"}'),
        ('expense','{"liability":"2241"}'),
        ('asset','{"asset":"1601","depreciation":"1602","disposal":"1606","gain":"5301","loss":"5711"}'),
        ('payroll','{"wages":"2211","social":"2211","housing":"2211","tax":"2211"}'),
        ('inventory','{"raw":"1403","finished":"1405","material":"400101","sales":"5401","adjustment":"1901"}');
    `);
    const insert =
      db.prepare(`INSERT OR IGNORE INTO fin_accounts(code,parent_code,name,category,direction,enabled)
      VALUES(?,?,?,'profit','debit',1)`);
    const expenses = {
      '5601': ['01 运输费', '02 业务招待费', '03 广告费', '04 职工薪酬', '05 折旧费', '99 其他'],
      '5602': [
        '01 办公费',
        '02 差旅费',
        '03 业务招待费',
        '04 职工薪酬',
        '05 折旧费',
        '06 水电费',
        '07 修理费',
        '99 其他',
      ],
    };
    // 有历史分录的主科目必须继续保持末级，保留 16 版可过账语义。
    for (const [parent, lines] of Object.entries(expenses)) {
      const account = db.prepare('SELECT used,enabled FROM fin_accounts WHERE code=?').get(parent);
      if (!account || account.used) continue;
      for (const line of lines) {
        const [suffix, name] = line.split(' ');
        insert.run(parent + suffix, parent, name);
      }
      if (!account.enabled)
        db.prepare('UPDATE fin_accounts SET enabled=0 WHERE parent_code=?').run(parent);
    }
    db.exec("INSERT INTO schema_migrations VALUES(17,datetime('now')); COMMIT");
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

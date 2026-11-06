import type { DatabaseSync } from 'node:sqlite';
import { presetAccounts } from '../../shared/finance-accounts.js';

export function migrateFinance(db: DatabaseSync) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=16').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=16').get()) {
      db.exec(`
        CREATE TABLE fin_settings (
          id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 1,
          start_period TEXT, taxpayer TEXT CHECK(taxpayer IN ('general','small')),
          require_separate_approver INTEGER NOT NULL DEFAULT 1,
          revenue_recognition TEXT NOT NULL DEFAULT 'delivery',
          cost_allocation TEXT NOT NULL DEFAULT 'output',
          aging_days TEXT NOT NULL DEFAULT '[30,60,90,180,365]',
          tax_rates TEXT NOT NULL DEFAULT '{"smallVat":null,"urban":null,"education":null,"localEducation":null,"income":null}'
        ) STRICT;
        INSERT INTO fin_settings(id) VALUES(1);
        CREATE TABLE fin_accounts (
          code TEXT PRIMARY KEY, parent_code TEXT REFERENCES fin_accounts(code),
          name TEXT NOT NULL, category TEXT NOT NULL, direction TEXT NOT NULL,
          cash_kind TEXT, auxiliary TEXT, enabled INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1, used INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE INDEX fin_accounts_parent ON fin_accounts(parent_code);
        CREATE TABLE fin_periods (
          period TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('open','closed')),
          version INTEGER NOT NULL DEFAULT 1
        ) STRICT;
        CREATE TABLE fin_opening (
          id INTEGER PRIMARY KEY, account_code TEXT NOT NULL REFERENCES fin_accounts(code),
          auxiliary_kind TEXT, auxiliary_id TEXT, auxiliary_name TEXT,
          debit INTEGER NOT NULL CHECK(debit>=0), credit INTEGER NOT NULL CHECK(credit>=0),
          year_debit INTEGER NOT NULL CHECK(year_debit>=0), year_credit INTEGER NOT NULL CHECK(year_credit>=0)
        ) STRICT;
        CREATE UNIQUE INDEX fin_opening_key ON fin_opening(account_code,coalesce(auxiliary_id,''));
        CREATE TABLE fin_requests (
          actor_id TEXT NOT NULL, request_id TEXT NOT NULL, action TEXT NOT NULL,
          fingerprint TEXT NOT NULL, response TEXT NOT NULL,
          PRIMARY KEY(actor_id,request_id)
        ) STRICT;
        CREATE TABLE fin_vouchers (
          id INTEGER PRIMARY KEY, number INTEGER NOT NULL, date TEXT NOT NULL,
          period TEXT NOT NULL REFERENCES fin_periods(period),
          description TEXT NOT NULL, attachment_count INTEGER NOT NULL,
          event_id INTEGER REFERENCES fin_events(id), reversal_of INTEGER REFERENCES fin_vouchers(id),
          status TEXT NOT NULL CHECK(status IN ('draft','pending','approved','posted','void')),
          maker_id TEXT NOT NULL, maker_name TEXT NOT NULL,
          approver_id TEXT, approver_name TEXT, approved_at TEXT,
          poster_id TEXT, poster_name TEXT, posted_at TEXT,
          created_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
          UNIQUE(period,number)
        ) STRICT;
        CREATE UNIQUE INDEX fin_vouchers_event ON fin_vouchers(event_id)
          WHERE event_id IS NOT NULL AND status<>'void';
        CREATE UNIQUE INDEX fin_vouchers_reversal ON fin_vouchers(reversal_of)
          WHERE reversal_of IS NOT NULL AND status<>'void';
        CREATE TABLE fin_entries (
          voucher_id INTEGER NOT NULL REFERENCES fin_vouchers(id),
          position INTEGER NOT NULL, account_code TEXT NOT NULL REFERENCES fin_accounts(code),
          description TEXT NOT NULL, debit INTEGER NOT NULL, credit INTEGER NOT NULL,
          auxiliary_kind TEXT, auxiliary_id TEXT, auxiliary_name TEXT, cash_flow TEXT,
          CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0)),
          PRIMARY KEY(voucher_id,position)
        ) STRICT;
        CREATE INDEX fin_entries_account ON fin_entries(account_code,voucher_id);
        CREATE TABLE fin_events (
          id INTEGER PRIMARY KEY, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
          event_type TEXT NOT NULL, source_version INTEGER NOT NULL, source_hash TEXT NOT NULL,
          date TEXT NOT NULL, amount_cents INTEGER, snapshot TEXT NOT NULL, status TEXT NOT NULL,
          voucher_id INTEGER REFERENCES fin_vouchers(id), problem TEXT, version INTEGER NOT NULL DEFAULT 1,
          revenue_recognition TEXT,
          UNIQUE(source_kind,source_id,event_type,source_version)
        ) STRICT;
        CREATE INDEX fin_events_status ON fin_events(status,date,id);
        CREATE TABLE fin_source_observations (
          source_kind TEXT NOT NULL, source_id TEXT NOT NULL, source_version INTEGER NOT NULL,
          status TEXT NOT NULL, event_id INTEGER NOT NULL REFERENCES fin_events(id),
          PRIMARY KEY(source_kind,source_id)
        ) STRICT;
        CREATE TABLE fin_templates (
          name TEXT PRIMARY KEY, mapping TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
        ) STRICT;
        INSERT INTO fin_templates(name,mapping) VALUES
          ('delivery.confirmed','{"party":"1122","net":"5001","tax":"22210102"}'),
          ('arrival.confirmed','{"party":"2202","net":"1403"}');
        CREATE TABLE fin_party_terms (
          kind TEXT NOT NULL, party_id TEXT NOT NULL, party_name TEXT NOT NULL,
          term_days INTEGER NOT NULL, credit_limit INTEGER, version INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY(kind,party_id)
        ) STRICT;
        CREATE TABLE fin_obligations (
          id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('receivable','payable')),
          party_id TEXT NOT NULL, party_name TEXT NOT NULL, date TEXT NOT NULL, due_date TEXT NOT NULL,
          amount_cents INTEGER NOT NULL, description TEXT NOT NULL, event_id INTEGER REFERENCES fin_events(id),
          voucher_id INTEGER REFERENCES fin_vouchers(id), version INTEGER NOT NULL DEFAULT 1
        ) STRICT;
        CREATE INDEX fin_obligations_party ON fin_obligations(kind,party_id,date);
      `);
      const insert = db.prepare(`INSERT INTO fin_accounts
        (code,parent_code,name,category,direction,cash_kind,auxiliary,enabled) VALUES(?,?,?,?,?,?,?,1)`);
      for (const account of presetAccounts)
        insert.run(
          account.code,
          account.code.length > 4 ? account.code.slice(0, -2) : null,
          account.name,
          account.category,
          account.direction,
          account.cashKind,
          account.auxiliary,
        );
      db.exec("INSERT INTO schema_migrations VALUES(16,datetime('now'))");
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

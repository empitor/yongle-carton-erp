import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import type { Actor } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import { exists, many, one, parseStoredJson, rows } from '../../core/index.js';
import { accountCodeSchema, templatePartyAccounts, templateTitles } from '../../../shared/finance/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { edit, label } from './query.js';

/** 模板里一项用途的名字最长几个字 */
const FIELD_NAME_MAX = 40;
/** fin_templates.mapping：用途 → 科目编码。保存时按它收，读出来也按它解析 */
const templateMapping = z.record(z.string().max(FIELD_NAME_MAX), accountCodeSchema);
/** 凭证模板的样子：名称、版本、各项对应的科目 */
const templateView = rows.fin_templates.pick({ name: true, version: true }).extend({ mapping: templateMapping });
type TemplateView = z.output<typeof templateView>;

function viewOf(row: z.output<typeof rows.fin_templates>): TemplateView {
  const where = `fin_templates.mapping（模板 ${row.name}）`;
  return { name: row.name, version: row.version, mapping: parseStoredJson(templateMapping, row.mapping, where) };
}
const readTemplate = (db: DatabaseSync, name: string) => {
  const row = one(db, rows.fin_templates, 'SELECT * FROM fin_templates WHERE name=?', name);
  return row && viewOf(row);
};

/** 模板能用的科目：已启用的末级科目 */
const usableAccount = (db: DatabaseSync, code: string) =>
  exists(
    db,
    `SELECT 1 FROM fin_accounts WHERE code=? AND enabled=1
    AND NOT EXISTS(SELECT 1 FROM fin_accounts a WHERE a.parent_code=fin_accounts.code)`,
    code,
  );

/** 取一个凭证模板，返回“按键取科目”的函数；科目编码按格式校验。 */
export function financeTemplate(store: Store, name: string) {
  const template = readTemplate(store.db, name);
  if (!template) financeError('凭证模板不存在。', 409);
  return (field: string) => accountCodeSchema.parse(template.mapping[field]);
}

/** 凭证模板页：列出和修改建库时预置的模板（只改科目，不增删键）。 */
export class FinanceTemplates {
  constructor(private readonly store: Store) {}

  list(actor: Actor | null): TemplateView[] {
    financeActor(actor, 'finance:close');
    return many(this.store.db, rows.fin_templates, 'SELECT * FROM fin_templates ORDER BY name').map(viewOf);
  }

  save(actor: Actor | null, raw: unknown): TemplateView {
    const user = financeActor(actor, 'finance:close');
    const input = edit.extend({ name: label, mapping: templateMapping }).parse(raw);
    return financeWrite(this.store, user, { action: 'templates.update', input, result: templateView }, () => {
      const db = this.store.db;
      const get = () => {
        const record = readTemplate(db, input.name);
        if (!record) financeError('凭证模板不存在。', 404);
        return record;
      };
      const before = get();
      checkVersion(before, input.version);
      if (
        Object.keys(before.mapping).sort().join(',') !== Object.keys(input.mapping).sort().join(',')
      )
        financeError('凭证模板必须完整填写原有科目映射。');
      for (const code of Object.values(input.mapping))
        if (!usableAccount(db, code)) financeError('模板科目须为已启用的末级科目。');
      // 往来科目的限制和页面同一份（shared/finance/templates.ts）
      const party = Object.hasOwn(templatePartyAccounts, input.name) ? templatePartyAccounts[input.name] : undefined;
      if (party && !String(input.mapping.party).startsWith(party.code))
        financeError(
          templateTitles[input.name] + '的往来科目只能用' + party.name + '（' + party.code + '）或它的下级科目：' +
            '对账单、账龄和收付款核销都按这个科目算。',
        );
      db.prepare('UPDATE fin_templates SET mapping=?,version=version+1 WHERE name=?').run(
        JSON.stringify(input.mapping),
        input.name,
      );
      const after = get();
      financeAudit(this.store, user, { action: 'update', entity: 'fin_templates', id: null, before, after });
      return after;
    });
  }
}

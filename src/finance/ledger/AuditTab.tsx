import { useState } from 'react';
import { financeAuditActions, financeAuditEntities } from '../../../shared/finance/index';
import { beijingTime } from '../../ui/index';
import { FinList, col, type Col } from '../table';
import { type HeadFn } from '../layout';
import type { FinData } from '../fin-api';
import { listAudit } from './ledger-api';

/** 一条修改记录 */
type AuditRow = FinData<'GET /finance/audit'>['rows'][number];
/** 按取值查叫法表（只认表里自己的键），没有返回 undefined */
const nameIn = (names: Readonly<Record<string, string>>, key: string) =>
  Object.hasOwn(names, key) ? names[key] : undefined;
/** 修改记录的列：时间按北京时间；叫法表覆盖了所有写审计的地方（financeAudit 的参数类型就是表的键，类型检查守着），不露英文动作名、表名和内部编号 */
const auditColumns: Col<AuditRow>[] = [
  col('at', '时间', { render: (r) => beijingTime(r.at) }),
  col('actor_name', '操作人'),
  col('action', '动作', { render: (r) => nameIn(financeAuditActions, r.action) ?? '其他操作' }),
  col('entity', '对象', { render: (r) => nameIn(financeAuditEntities, r.entity) ?? '其他财务记录' }),
];

export default function AuditTab({ head }: { head: HeadFn }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  return (
    <>
      {head({})}
      <div className="fin-toolbar">
        <input
          type="date"
          aria-label="开始日期"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        至
        <input
          type="date"
          aria-label="结束日期"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      <FinList
        list={listAudit}
        label="修改记录"
        query={{ from: from || undefined, to: to || undefined }}
        empty="没有记录"
        cols={auditColumns}
      />
    </>
  );
}

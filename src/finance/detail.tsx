import { Progress, yuan } from '../ui/index';
import { Status } from './status';

/* 财务详情面板共用的小件：金额进度、凭证列表、带正负的金额。版式沿用 src/ui/Record.tsx。 */

/** 金额进度，例如“已核销 1,000.00 / 1,500.00 元”。金额是整数分。 */
export function MoneyProgress({ label, done, total }: { label: string; done: unknown; total: unknown }) {
  const d = Number(done) || 0,
    t = Number(total) || 0;
  return <Progress label={label} done={d} total={t} text={yuan(d) + ' / ' + yuan(t) + ' 元'} />;
}

/** 来源记录上挂的一张凭证（fin_vouchers 的编号、期间、号、状态） */
type VoucherLink = { id: number; period: string; number: number; status: string };

/** 相关凭证：点编号去凭证页。 */
export function VoucherLinks({ vouchers }: { vouchers: readonly VoucherLink[] }) {
  return (
    <ul className="record-links">
      {vouchers.map((v) => (
        <li key={v.id}>
          <a href={'#finance-ledger?voucher=' + v.id}>{v.period + ' 第 ' + v.number + ' 号'}</a>
          <small>
            <Status value={v.status} />
          </small>
        </li>
      ))}
    </ul>
  );
}

/** 金额带正负时写成“收入 / 支出”，不用读负号。 */
export function signedAmount(cents: unknown, positive = '收入', negative = '支出') {
  const n = Number(cents) || 0;
  return (n < 0 ? negative : positive) + ' ' + yuan(Math.abs(n)) + ' 元';
}

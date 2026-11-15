import { call } from '../../ui/index';
import { finWritten, requestId, type FinanceWrites } from '../fin-api';

/* 财务设置的写入：基本设置、科目、启用财务（期初余额）。正文照 shared/finance 的规则，请求号这里补。 */

const send = call<FinanceWrites>();
/** 一个写地址的正文，去掉这里补的请求号 */
type BodyOf<K extends keyof FinanceWrites> = Omit<FinanceWrites[K]['body'], 'requestId'>;

export const saveSettings = (body: BodyOf<'PUT /finance/settings'>) =>
  finWritten(send('PUT /finance/settings', { body: { ...body, requestId: requestId() } }));
export const saveSubject = (body: BodyOf<'PUT /finance/accounts'>) =>
  finWritten(send('PUT /finance/accounts', { body: { ...body, requestId: requestId() } }));
export const enableFinance = (body: BodyOf<'POST /finance/opening/enable'>) =>
  finWritten(send('POST /finance/opening/enable', { body: { ...body, requestId: requestId() } }));

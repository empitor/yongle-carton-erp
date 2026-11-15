import { useEffect } from 'react';
import { call, useAuthState, listen, useLoad, useSlots } from '../ui/index';
import { MAX_PAGE_SIZE } from '../../shared/core/index';
import type { FinanceApi } from '../../shared/finance/index';

/*
 * 财务页面共用的取数、写入、上传、导出地址和权限（接口表 shared/finance/finance-api.ts）。
 * 读：页面用 useFinRead / useFinLoad，*-api.ts 和服务接口用 finRead。
 * 写：各页签的 *-api.ts 自己建 `const send = call<FinanceWrites>()` 发（一个写地址只由一个文件发，检查按调 call() 的文件算），
 * 发出去的交给 finWritten，写完让财务页面重读。
 */

type FinKey = keyof FinanceApi & `${string} /${string}`;
/** 财务的读地址（接口表的键，'GET /finance/…'） */
type FinReadKey = Extract<FinKey, `GET ${string}`>;
type FinWriteKey = Exclude<FinKey, FinReadKey>;
/** 财务的写地址：各页签 *-api.ts 用 call<FinanceWrites>() 发 */
export type FinanceWrites = Pick<FinanceApi, FinWriteKey>;
const reader = call<Pick<FinanceApi, FinReadKey>>();
/** 一个地址的回答（类型来自接口表） */
export type FinData<K extends FinKey> = FinanceApi[K]['response'];
/** 地址键后面要给的：路径参数、查询参数（和 call() 的一样，按接口表检查） */
type ReadInput<K extends FinReadKey> = typeof reader<K> extends (key: K, ...input: infer I) => unknown ? I : never;
/** 一次读：地址键加参数，useFinRead 收它（读不了时给 null） */
export type FinRequest<K extends FinReadKey> = [key: K, ...input: ReadInput<K>];
/** 一个读地址的查询参数（FinList 的读法收它） */
export type FinQuery<K extends FinReadKey> =
  FinRequest<K> extends [unknown, (infer I)?] ? (I extends { query?: infer Q } ? NonNullable<Q> : never) : never;

/** 财务数据变了：财务页面里取的数都重读。只在财务模块里用，所以不登记到全站事件表。 */
const changeListeners = new Set<() => void>();
function finChanged() {
  for (const listener of changeListeners) listener();
}

/** 按接口表读一次：finRead('GET /finance/vouchers/:id', { params: { id } }) */
export function finRead<K extends FinReadKey>(key: K, ...input: ReadInput<K>): Promise<FinData<K>> {
  return reader(key, ...input);
}
/**
 * 写完让财务页面重读：finWritten(send('PUT /finance/accounts', { body: { …, requestId: requestId() } }))。
 * 防重复的请求号由调用方放进正文（同一次操作重试时沿用同一个）。
 */
export function finWritten<T>(sent: Promise<T>): Promise<T> {
  return sent.then((result) => {
    finChanged();
    return result;
  });
}
/** 新的防重复请求号 */
export const requestId = () => crypto.randomUUID();

/**
 * 财务页面取数：key 变了重读（null 不读）；财务里办完一件事，或者业务数据变了（别处保存、切回这个页面时）也重读。
 * 读法由调用方给（各页签 *-api.ts 的读函数，或几次读合在一起），返回值的类型从读法推出来。
 */
export function useFinLoad<T>(key: string | null, load: (key: string) => Promise<T>) {
  const result = useLoad(key, load);
  const { reload } = result;
  useEffect(() => {
    changeListeners.add(reload);
    const stopBusinessChanged = listen('erp-business-changed', reload);
    return () => {
      changeListeners.delete(reload);
      stopBusinessChanged();
    };
  }, [reload]);
  return result;
}
/** 按接口表读一个地址：useFinRead(['GET /finance/summary'])；条件不够时给 null，不读 */
export function useFinRead<K extends FinReadKey>(request: FinRequest<K> | null) {
  // useLoad 只在 key 不是 null（有 request）时才读
  return useFinLoad(request && JSON.stringify(request), () =>
    request ? reader(...request) : Promise.reject(new Error('没有要读的财务地址。')),
  );
}

/* ---------- 上传、导出 ---------- */

/** 上传、导出地址上的查询参数：空的条件不带 */
const qs = (query?: Record<string, unknown>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {}))
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const text = params.toString();
  return text ? '?' + text : '';
};

/**
 * 上传走 src/ui 的 uploadFile，完整地址写在各子目录的接口文件里（cash-api.ts、costs-api.ts）；
 * 这里只补防重复编号（uploadQuery）、失败说法（uploadFailure），传完交给 finWritten 让财务页面重读。
 */
export const uploadQuery = (query: Record<string, unknown>) => qs({ requestId: requestId(), ...query });
export const uploadFailure = (file: File) => ({ failure: file.name + ' 上传失败' });
export const exportHref = (path: string, query?: Record<string, unknown>) =>
  '/api/finance' + path + qs(query);

/** 补扫只在这里发（打开概览、月度台账、业务单据页和启用财务后） */
const send = call<FinanceWrites>();
/** 打开财务页面时补扫业务单据（一次一批，最多 20 批），让台账和待补清单都是最新的；补扫到东西时让财务页面重读。 */
const SYNC_MAX_BATCHES = 20;
export async function syncEvents() {
  let processed = 0;
  try {
    for (let i = 0; i < SYNC_MAX_BATCHES; i++) {
      const r = await send('POST /finance/events/sync', { body: { requestId: requestId() } });
      processed += r.processed;
      if (!r.remaining) return;
    }
  } finally {
    if (processed > 0) finChanged();
  }
}

/* ---------- 权限、几处共用的选项 ---------- */

export function useFinPerms() {
  const auth = useAuthState();
  const has = (p: string) => !!auth?.actor?.permissions.includes('finance:' + p);
  return {
    view: has('view'),
    edit: has('edit'),
    approve: has('approve'),
    cash: has('cash'),
    close: has('close'),
    isSuper: auth?.actor?.role === 'super_admin',
    actorId: auth?.actor?.id,
  };
}
/** 选客户、供应商的下拉选项。往来单位由业务模块提供（插槽里的服务接口），财务不直接请求业务的地址 */
export function useParties(kind: 'customer' | 'supplier' | null) {
  const { parties } = useSlots();
  // 读不出来时下拉是空的，不另外报错（选单位的输入框旁边没有放出错的地方）；useLoad 只在 key 不是 null（两样都有）时才读
  const { data } = useLoad(kind && parties ? kind : null, () =>
    kind && parties ? parties.list(kind) : Promise.reject(new Error('往来单位的接口没有装上。')),
  );
  return (data ?? []).map((p) => ({ value: String(p.id), label: p.name }));
}
/** 资金账户一次全取（服务端一页最多 MAX_PAGE_SIZE 条，账户不会有这么多）：选账户的下拉、资金发票页都这样读 */
export const ALL_CASH_ACCOUNTS: FinRequest<'GET /finance/cash/accounts'> = [
  'GET /finance/cash/accounts',
  { query: { pageSize: MAX_PAGE_SIZE } },
];
/** 启用的资金账户（选收付款账户用）；还没读到时是空的 */
export function useCashAccounts() {
  const { data } = useFinRead(ALL_CASH_ACCOUNTS);
  return data ? data.rows.filter((a) => a.enabled) : [];
}
/** 全部科目（按编码排）；还没读到时是空的 */
export function useAccounts() {
  const { data } = useFinRead(['GET /finance/accounts']);
  return data ?? [];
}

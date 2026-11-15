import type { ReactNode } from 'react';

/** 供应商、采购单、库存、流水页的列表区：读不出的原因、办完的提示、第一次读取中，然后是列表本身。 */
export default function RecordPageBody({
  error,
  notice,
  loading,
  children,
}: {
  error: string;
  notice?: string;
  /** 正在读、手里还没有一条 */
  loading: boolean;
  children: ReactNode;
}) {
  return (
    <>
      {error && (
        <p role="alert" className="operation-error">
          {error}
        </p>
      )}
      {notice && (
        <p className="business-result" role="status">
          {notice}
        </p>
      )}
      {error ? null : loading ? <p className="empty">正在读取业务数据…</p> : children}
    </>
  );
}

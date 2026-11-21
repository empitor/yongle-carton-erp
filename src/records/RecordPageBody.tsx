import type { ReactNode } from 'react';
import { FormMessage, loadingText } from '../ui/index';

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
      <FormMessage>{error}</FormMessage>
      {notice && (
        <p className="business-result" role="status">
          {notice}
        </p>
      )}
      {error ? null : loading ? (
        <p className="empty" role="status">
          {loadingText('业务数据')}
        </p>
      ) : (
        children
      )}
    </>
  );
}

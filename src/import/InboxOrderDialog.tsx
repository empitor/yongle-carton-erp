import { lazy, Suspense, useEffect, useEffectEvent } from 'react';
import { errorMessage, type Order } from '../../shared/core/index';
import type { InboxItem } from '../../shared/import/index';
import { readCatalog } from '../recordkit/index';
import { emit, notify, useLoad } from '../ui/index';
import { inboxFileUrl, setInboxStatus } from './inbox-api';

// 订单编辑窗点了才下载，不进首屏
const OrderEditor = lazy(() => import('../editors/pages').then((m) => ({ default: m.OrderEditor })));

/** 收件箱一条转成订单编辑窗上方的对照原文 */
export function inboxOrderSource(row: Pick<InboxItem, 'id' | 'status' | 'senderName' | 'conversation' | 'text' | 'fileName'>) {
  return {
    title: '收件箱原文',
    meta: [row.senderName, row.conversation].filter(Boolean).join(' · ') || '手动添加',
    hint: row.status === 'pending' ? '保存订单后标为已处理' : undefined,
    text: row.text || undefined,
    file: row.fileName ? { name: row.fileName, url: inboxFileUrl(row.id) } : undefined,
  };
}

/** 订单存好后由识别导入自己标“已转订单”；标记失败明确提示，不吞错 */
export async function finishInboxOrder(
  row: Pick<InboxItem, 'id' | 'version' | 'status'>,
  record: Pick<Order, 'number'>,
  savedMessage: string,
  mark: (item: Pick<InboxItem, 'id' | 'version'>) => Promise<unknown> = (item) =>
    setInboxStatus(item, 'converted', 'order'),
): Promise<{ message: string; tone: 'done' | 'error' }> {
  if (row.status !== 'pending') return { message: savedMessage, tone: 'done' };
  try {
    await mark(row);
    return { message: savedMessage.replace(/。$/, '') + '，收件已标为已处理。', tone: 'done' };
  } catch (err: unknown) {
    const head = record.number ? '订单 ' + record.number + ' 已建立' : '订单已建立';
    return { message: head + '，但收件没能标为已处理：' + errorMessage(err), tone: 'error' };
  }
}

/** 在收件箱页直接打开新建订单窗：传入原文和原文件下载链接，保存后标记收件为已处理，人留在收件箱页 */
export default function InboxOrderDialog({ row, close }: { row: InboxItem; close: () => void }) {
  const catalog = useLoad('inbox-order-' + row.id, () => readCatalog(['customers', 'products']));
  const onLoadFailed = useEffectEvent((message: string) => {
    notify('没读到客户和产品档案：' + message, 'error');
    close();
  });
  useEffect(() => {
    if (catalog.error) onLoadFailed(catalog.error);
  }, [catalog.error]);
  if (catalog.error) return null;
  const saved = async (record: Order, message: string) => {
    const outcome = await finishInboxOrder(row, record, message);
    emit('erp-business-changed');
    close();
    notify(outcome.message, outcome.tone);
  };
  return (
    <Suspense fallback={<p role="status">正在打开…</p>}>
      <OrderEditor
        loading={catalog.loading}
        source={inboxOrderSource(row)}
        customers={catalog.data?.customers ?? []}
        products={catalog.data?.products ?? []}
        close={close}
        saved={saved}
      />
    </Suspense>
  );
}

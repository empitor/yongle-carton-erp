import { useEffect, useState } from 'react';
import { listen } from '../ui/index';

/** 页面告诉助手正在看的那条记录 */
export type RecordContext = { module: string; id: number; label: string };

/**
 * 输入框上方“已选的记录”：页面打开一条记录时记下（下一句话带给助手），换页、换账号或点掉时清空。
 * 返回眼前这条和清掉它的函数。
 */
export function useRecordContext(userId: string | undefined) {
  const [context, setContext] = useState<RecordContext | null>(null);
  useEffect(() => setContext(null), [userId]);
  useEffect(() => {
    const route = () => setContext(null);
    window.addEventListener('hashchange', route);
    const stop = listen('erp-ai-record-context', setContext);
    return () => {
      window.removeEventListener('hashchange', route);
      stop();
    };
  }, []);
  return [context, () => setContext(null)] as const;
}

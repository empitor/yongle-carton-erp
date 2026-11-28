import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../shared/core/index';
import { listen } from './events';

/* 页面里读数据、办一件小事的几个 hook：读一份数据、点一下执行、业务数据变了就重读。 */

/**
 * useLoad 眼前这份数据读到哪了（read 是上一次读完的 key、第几次 reload 和当时的 refresh）：loading 是“眼前这份还不是这个 key 的”；
 * reloading 是“还是这个 key，调了 reload 或 refresh 变了、这一次还没读完”（重试按钮靠它显示点上了，这时旧内容照常显示）。
 */
export function loadStatus(
  read: { key: string | null; revision: number; refresh?: unknown },
  key: string | null,
  revision: number,
  refresh?: unknown,
) {
  const again = read.revision !== revision || !Object.is(read.refresh, refresh);
  return { loading: read.key !== key, reloading: key !== null && read.key === key && again };
}

/**
 * 按 key 读一份数据：key 变了、调了 reload 或 refresh 变了就重读；key 为 null 时不读。
 * key 是“读哪一份”，变了眼前这份就不算数（loading）；refresh 是“同一份再读一次”的理由（例如业务版本号），
 * 变了只算重读（reloading），读完之前旧内容照常显示，不闪“正在读取…”。
 * 读失败时留着上一份数据、给出原因；loading、reloading 见 loadStatus。
 */
export function useLoad<T>(key: string | null, load: (key: string) => Promise<T>, refresh?: unknown) {
  const [state, setState] = useState<{ key: string | null; revision: number; refresh?: unknown; data: T | null; error: string }>({
    key: null,
    revision: 0,
    data: null,
    error: '',
  });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((v) => v + 1), []);
  // 只按 key 和 reload 重读：load 每次渲染都是新函数，放进 ref 里取最新的，不当作重读的理由
  const latestLoad = useRef(load);
  useEffect(() => {
    latestLoad.current = load;
  });
  useEffect(() => {
    if (key === null) return;
    let active = true;
    latestLoad
      .current(key)
      .then((data) => active && setState({ key, revision, refresh, data, error: '' }))
      .catch((e: unknown) => active && setState((s) => ({ key, revision, refresh, data: s.data, error: errorMessage(e) })));
    return () => {
      active = false;
    };
  }, [key, revision, refresh]);
  return { data: state.data, error: state.error, ...loadStatus(state, key, revision, refresh), reload };
}

/** 按钮点一下就执行、失败时给出原因的小动作。 */
export function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, clear: () => setError('') };
}

/** 业务数据变了（保存、删除、导入、助手办完）就重读：返回随之加一的版本号，和手动重读一次的 bump */
export function useBusinessRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => listen('erp-business-changed', () => setRevision((v) => v + 1)), []);
  return [revision, () => setRevision((v) => v + 1)] as const;
}

import { useMemo, useRef, useState } from 'react';
import { catalogKeys, readCatalog, type CatalogKey, type CatalogLists } from './catalog-api';

/** [档案, 是否必须是本次业务版本之后读到的]。只显示名称和单号的地方用以前读过的就够了。 */
export type CatalogNeed = [CatalogKey, boolean];
/** 读到的几份清单，和各自是在哪个业务版本读的（两份按同样的键记） */
type Entries = { values: Partial<CatalogLists>; revisions: Partial<Record<CatalogKey, number>> };
/** 进行中的读取：按哪个业务版本读的，等它读完 */
type Pending = Partial<Record<CatalogKey, { revision: number; promise: Promise<unknown> }>>;
const emptyEntries = (): Entries => ({ values: {}, revisions: {} });
const sameEntries = (a: Entries, b: Entries) =>
  catalogKeys.every((key) => a.values[key] === b.values[key] && a.revisions[key] === b.revisions[key]);
/** 读到了这一份（fresh 时还要是 revision 这个业务版本读的） */
const hasEntry = (entries: Entries, key: CatalogKey, fresh: boolean, revision: number) =>
  entries.values[key] !== undefined && (!fresh || entries.revisions[key] === revision);

/** 全部清单：读到的用读到的，没读过的先给空列表；调用方给了的（given）用给的 */
const dataOf = ({ values }: Entries, given: Partial<CatalogLists> | undefined): CatalogLists => ({
  orders: values.orders || [],
  pendingOrders: values.pendingOrders || [],
  products: values.products || [],
  suppliers: values.suppliers || [],
  customers: values.customers || [],
  purchases: values.purchases || [],
  items: values.items || [],
  rawItems: values.rawItems || [],
  finishedItems: values.finishedItems || [],
  tasks: values.tasks || [],
  productions: values.productions || [],
  pendingDeliveries: values.pendingDeliveries || [],
  ...given,
});

/**
 * 档案按需读取并缓存：业务变化（revision 变了）后旧值仍可用来显示名称，要最新的时再读。同一份档案同时只读一次。
 * all：连同已归档的一起读（换了就整份重读）。given：调用方手里已经有的清单（生产任务列表本身就是任务清单），不再读。
 */
export function useCatalog({ all, revision, given }: { all: boolean; revision: number; given?: Partial<CatalogLists> }) {
  const [entries, setEntries] = useState<Entries>(emptyEntries);
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const cache = useRef<{ scope: boolean | null; entries: Entries; pending: Pending }>({
    scope: null,
    entries: emptyEntries(),
    pending: {},
  });
  /** 读一份：没有进行中的（或要最新而进行中的是旧版本的）才发请求 */
  function fetchOne<K extends CatalogKey>(key: K, fresh: boolean, rev: number) {
    const c = cache.current,
      own = c.entries;
    const job = c.pending[key];
    if (job && !(fresh && job.revision !== rev)) return job.promise;
    const current = { revision: rev, promise: readCatalog([key], { all: !!c.scope }).then((r) => r[key]) };
    c.pending[key] = current;
    current.promise.then(
      (value) => {
        if (c.pending[key] === current) delete c.pending[key];
        if (c.entries === own && (own.revisions[key] ?? -1) <= rev) {
          own.values[key] = value;
          own.revisions[key] = rev;
        }
      },
      () => {
        if (c.pending[key] === current) delete c.pending[key];
      },
    );
    return current.promise;
  }
  /** 按需读：没读过的、或要求最新而已过期的才去读；读完返回全部清单 */
  async function ensure(needs: CatalogNeed[]) {
    const c = cache.current,
      rev = revisionRef.current;
    if (c.scope !== all) Object.assign(c, { scope: all, entries: emptyEntries(), pending: {} });
    const own = c.entries;
    const stale = needs.filter(([key, fresh]) => !given?.[key] && !hasEntry(own, key, fresh, rev));
    await Promise.all(stale.map(([key, fresh]) => fetchOne(key, fresh, rev)));
    if (c.entries === own)
      setEntries((old) =>
        sameEntries(old, own) ? old : { values: { ...own.values }, revisions: { ...own.revisions } },
      );
    return dataOf(own, given);
  }
  const data = useMemo(() => dataOf(entries, given), [entries, given]);
  /** 档案已读到（fresh 时还要是本次刷新后读的）。 */
  const loaded = (key: CatalogKey, fresh = false) => !!given?.[key] || hasEntry(entries, key, fresh, revision);
  const ready = (needs: CatalogNeed[]) => needs.every(([key]) => loaded(key));
  return { ensure, data, loaded, ready };
}

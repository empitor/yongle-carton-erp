import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../shared/core/index';
import {
  blocksNewProduct,
  emptyImportMapping,
  importNameKey,
  invalidateImportMapping,
  productCandidatesForLine,
  productMatchKey,
  productsForCustomer,
  resolveCustomerCandidates,
  type ImportMapping,
  type ImportMatchData,
  type ImportWorkspaceView,
  type MappingInvalidations,
  type OrderDraft,
} from '../../shared/import/index';
import { readMatches } from './workspace-api';

/**
 * 订单识别结果里客户、产品对哪个档案：读候选档案，按名字唯一对上的、本客户老产品直接选中，人改的先留在页面上，
 * 保存时交给 onSave（保存客户与产品选择）。服务端回来的新版本没被本地改过的选择覆盖时跟着它。
 */
type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type Candidates = ReturnType<typeof productCandidatesForLine>;
type CustomerResolution = ReturnType<typeof resolveCustomerCandidates>;
const noInvalidations = (): MappingInvalidations => ({ products: {} });

const normalized = (mapping: ImportMapping | undefined, draft: OrderDraft): ImportMapping => ({
  ...emptyImportMapping(draft),
  ...mapping,
  products: { ...emptyImportMapping(draft).products, ...mapping?.products },
});

/** 读这份文件的候选档案：只收和当前版本对得上的那一份 */
function useMatches(workspace: ImportWorkspaceView) {
  const [matches, setMatches] = useState<ImportMatchData | null>(null),
    [readError, setReadError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    readMatches(workspace.id, controller.signal)
      .then((data) => {
        if (current && data.revision === workspace.revision) {
          setMatches(data);
          setReadError('');
        }
      })
      .catch((e: unknown) => {
        if (current && !(e instanceof Error && e.name === 'AbortError')) setReadError(errorMessage(e));
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [workspace.id, workspace.revision]);
  return { matches, readError };
}

/**
 * 页面上的客户、产品选择，和服务端存的那份怎么跟：服务端来了新版本、本地没改过（也没在保存）就跟着它；
 * 识别结果改了（换了客户名、改了明细）按规则作废受影响的选择。
 */
function useMappingState(workspace: ImportWorkspaceView, draft: OrderDraft) {
  const [mapping, setMapping] = useState(() => normalized(workspace.mapping, draft));
  const [invalidated, setInvalidated] = useState<MappingInvalidations>(workspace.mappingInvalidated || noInvalidations());
  const [saveState, setSaveState] = useState<SaveState>(workspace.mapping ? 'saved' : 'idle');
  const [saveError, setSaveError] = useState('');
  const mappingRef = useRef(mapping),
    invalidRef = useRef(invalidated),
    priorDraft = useRef(draft),
    saving = useRef(false),
    savedRef = useRef(normalized(workspace.mapping, draft));
  // 新版本到了才跟（按版本号重跑）；跟的时候取这一刻的工作区和识别结果
  const latest = useRef({ workspace, draft });
  latest.current = { workspace, draft };
  const update = useCallback((next: ImportMapping, notices = invalidRef.current) => {
    mappingRef.current = next;
    invalidRef.current = notices;
    setMapping(next);
    setInvalidated(notices);
  }, []);
  useEffect(() => {
    const { workspace: w, draft: d } = latest.current;
    const localDirty = JSON.stringify(mappingRef.current) !== JSON.stringify(savedRef.current);
    savedRef.current = normalized(w.mapping, d);
    if (!localDirty && !saving.current) {
      update(savedRef.current, w.mappingInvalidated || noInvalidations());
      setSaveState(w.mapping ? 'saved' : 'idle');
    }
  }, [workspace.revision, update]);
  useEffect(() => {
    const next = invalidateImportMapping(mappingRef.current, priorDraft.current, draft, invalidRef.current);
    priorDraft.current = draft;
    if (
      next.mapping &&
      (JSON.stringify(next.mapping) !== JSON.stringify(mappingRef.current) ||
        JSON.stringify(next.invalidated) !== JSON.stringify(invalidRef.current))
    ) {
      update(next.mapping, next.invalidated);
      setSaveState('idle');
      setSaveError('');
    }
  }, [draft, update]);
  return { mapping, invalidated, saveState, setSaveState, saveError, setSaveError, mappingRef, invalidRef, saving, update };
}
type MappingState = ReturnType<typeof useMappingState>;

/** 客户按名字找候选：候选档案和识别结果是同一版、客户名没改过就用服务端算好的，否则按眼前的客户名重算 */
function useCustomerResolution(matches: ImportMatchData | null, draft: OrderDraft, workspace: ImportWorkspaceView) {
  const buyer = draft.header.buyerName.value || '',
    savedBuyer = workspace.draft?.header.buyerName.value || '',
    revision = workspace.revision;
  return useMemo(() => {
    if (!matches) return null;
    return matches.revision === revision && importNameKey(buyer) === importNameKey(savedBuyer)
      ? matches.customerResolution
      : resolveCustomerCandidates(matches.customerRecords, buyer);
  }, [matches, buyer, savedBuyer, revision]);
}

/** 每行产品的候选档案（按行缓存：这一行的名称尺寸、档案、当前客户都没变就不重算） */
function useCandidates(draft: OrderDraft, matches: ImportMatchData | null, customerId: number | null) {
  const cache = useRef(
    new Map<
      string,
      { key: string; products: ImportMatchData['products']; customerId: number | null; value: Candidates }
    >(),
  );
  return useMemo(
    () =>
      Object.fromEntries(
        draft.lines.map((l) => {
          const products = matches?.products || [],
            key = productMatchKey(l),
            cached = cache.current.get(l.id);
          if (cached?.key === key && cached.products === products && cached.customerId === customerId)
            return [l.id, cached.value];
          const value = productCandidatesForLine(l, products, customerId);
          cache.current.set(l.id, { key, products, customerId, value });
          return [l.id, value];
        }),
      ),
    [draft, matches, customerId],
  );
}

/**
 * 按名字唯一对上的客户，和名称、尺寸都相同又没有冲突的唯一档案、本客户的老产品，直接选中（人没碰过、没被作废的才选）。
 * 每月重复下单时不用一行行点确认。
 */
function useAutoChoose(
  state: MappingState,
  found: { matches: ImportMatchData | null; customer: CustomerResolution | null; candidates: Record<string, Candidates> },
  lines: OrderDraft['lines'],
  touched: { customer: { current: boolean }; products: { current: Set<string> } },
) {
  const { matches, customer, candidates } = found;
  // 下面几样都不随渲染变（引用、useCallback 的 update、状态的设值函数），effect 只跟着候选和识别结果重跑
  const { mappingRef, invalidRef, update, setSaveState } = state,
    { customer: customerTouched, products: productTouched } = touched;
  useEffect(() => {
    if (customer?.state !== 'resolved' || mappingRef.current.customer.mode !== 'pending') return;
    if (invalidRef.current.customer || customerTouched.current) return;
    const c = customer.customer;
    update({ ...mappingRef.current, customer: { mode: 'existing', id: c.id, version: c.version } });
    setSaveState('idle');
  }, [customer, mappingRef, invalidRef, customerTouched, update, setSaveState]);
  useEffect(() => {
    if (!matches) return;
    let next = mappingRef.current,
      changed = false;
    for (const l of lines) {
      const choice = next.products[l.id];
      if ((choice && choice.mode !== 'pending') || invalidRef.current.products[l.id] || productTouched.current.has(l.id))
        continue;
      const best = candidates[l.id]?.filter((c) => c.recommended) || [];
      const product = best.length === 1 ? matches.products.find((p) => p.id === best[0].id) : undefined;
      if (!product) continue;
      next = { ...next, products: { ...next.products, [l.id]: { mode: 'existing', id: product.id, version: product.version } } };
      changed = true;
    }
    if (changed) {
      update(next);
      setSaveState('idle');
    }
  }, [candidates, matches, lines, mappingRef, invalidRef, productTouched, update, setSaveState]);
}

/** 还有没处理完的：被作废的、客户对不上唯一一个、选的档案已经变了或属别家客户、有行不能新建又没选 */
function unresolvedOf(
  state: Pick<MappingState, 'mapping' | 'invalidated'>,
  found: { matches: ImportMatchData | null; customer: CustomerResolution | null; candidates: Record<string, Candidates> },
  lines: OrderDraft['lines'],
  customerId: number | null,
) {
  const { mapping, invalidated } = state,
    { matches, customer, candidates } = found,
    chosen = mapping.customer;
  return (
    !!invalidated.customer ||
    Object.keys(invalidated.products).length > 0 ||
    (chosen.mode === 'pending' && customer?.state === 'ambiguous') ||
    (!!matches && chosen.mode === 'existing' && !matches.customers.some((c) => c.id === chosen.id && c.version === chosen.version)) ||
    (!!matches &&
      Object.values(mapping.products).some((choice) => {
        if (choice.mode !== 'existing') return false;
        const p = matches.products.find((x) => x.id === choice.id && x.version === choice.version);
        return !p || (p.customerId != null && p.customerId !== customerId);
      })) ||
    lines.some(
      (l) =>
        (!mapping.products[l.id] || mapping.products[l.id].mode === 'pending') && candidates[l.id]?.some(blocksNewProduct),
    )
  );
}

/** 保存客户与产品选择：同一时间只存一次；回来晚了的结果不盖掉这期间又改的选择 */
function useMappingSave(
  state: MappingState,
  workspace: ImportWorkspaceView,
  draft: OrderDraft,
  onSave: (mapping: ImportMapping) => Promise<ImportWorkspaceView | null>,
) {
  const live = useRef(true),
    workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return async function save() {
    const { mappingRef, saving } = state;
    if (saving.current) return;
    saving.current = true;
    state.setSaveState('saving');
    state.setSaveError('');
    const snapshot = mappingRef.current;
    try {
      const result = await onSave(structuredClone(snapshot));
      if (!live.current) return;
      if (!result) throw Error('保存失败，当前选择已保留，请重试。');
      if (result.revision < workspaceRef.current.revision)
        throw Error('工作区已有后续修订，当前选择已保留，请核对后再保存。');
      if (mappingRef.current === snapshot) {
        state.update(normalized(result.mapping, draft), result.mappingInvalidated || noInvalidations());
        state.setSaveState('saved');
      } else state.setSaveState('idle');
    } catch (e) {
      if (live.current) {
        state.setSaveError(errorMessage(e));
        state.setSaveState('error');
      }
    } finally {
      saving.current = false;
    }
  };
}

export function useImportMatching(
  workspace: ImportWorkspaceView,
  draft: OrderDraft,
  onSave: (mapping: ImportMapping) => Promise<ImportWorkspaceView | null>,
) {
  const { matches, readError } = useMatches(workspace);
  const state = useMappingState(workspace, draft);
  const { mapping, invalidRef } = state;
  const customerTouched = useRef(false),
    productTouched = useRef(new Set<string>());
  const save = useMappingSave(state, workspace, draft, onSave);
  const customerResolution = useCustomerResolution(matches, draft, workspace);
  // 产品候选只列当前选定客户的产品和没定客户的通用产品；新客户只看没定客户的
  const customerId =
    mapping.customer.mode === 'existing'
      ? mapping.customer.id
      : mapping.customer.mode === 'new'
        ? null
        : customerResolution?.state === 'resolved'
          ? customerResolution.customer.id
          : null;
  const eligibleProducts = useMemo(
    () => (matches ? productsForCustomer(matches.products, customerId) : []),
    [matches, customerId],
  );
  const candidates = useCandidates(draft, matches, customerId);
  const found = { matches, customer: customerResolution, candidates };
  useAutoChoose(state, found, draft.lines, { customer: customerTouched, products: productTouched });
  const select = (next: ImportMapping, kind: 'customer' | string) => {
    const notices = structuredClone(invalidRef.current);
    const updated = structuredClone(next);
    if (kind === 'customer') {
      customerTouched.current = true;
      delete notices.customer;
      const nextCid = updated.customer.mode === 'existing' ? updated.customer.id : null;
      if (matches)
        for (const [lineId, choice] of Object.entries(updated.products)) {
          if (choice.mode !== 'existing') continue;
          const p = matches.products.find((x) => x.id === choice.id);
          if (p && p.customerId != null && p.customerId !== nextCid) {
            updated.products[lineId] = { mode: 'pending' };
            notices.products[lineId] = '已更换客户，原产品属于其他客户，请重新选择';
          }
        }
    } else {
      productTouched.current.add(kind);
      delete notices.products[kind];
    }
    state.update(updated, notices);
    state.setSaveState('idle');
    state.setSaveError('');
  };
  return {
    matches,
    customerId,
    eligibleProducts,
    readError,
    mapping,
    invalidated: state.invalidated,
    customerResolution,
    candidates,
    select,
    save,
    saveState: state.saveState,
    saveError: state.saveError,
    dirty: JSON.stringify(mapping) !== JSON.stringify(normalized(workspace.mapping, draft)),
    unresolved: unresolvedOf(state, found, draft.lines, customerId),
  };
}

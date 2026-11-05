import { useEffect, useMemo, useRef, useState } from 'react';
import type { ImportMapping } from '../../shared/import-mapping';
import type { ImportWorkspaceView, OrderDraft } from '../../shared/order-draft';
import {
  emptyImportMapping,
  importNameKey,
  invalidateImportMapping,
  productCandidatesForLine,
  productMatchKey,
  resolveCustomerCandidates,
  type ImportMatchData,
  type MappingInvalidations,
} from '../../shared/import-matching';

const normalized = (mapping: ImportMapping | undefined, draft: OrderDraft): ImportMapping => ({
  ...emptyImportMapping(draft),
  ...mapping,
  products: { ...emptyImportMapping(draft).products, ...mapping?.products },
});
export function useImportMatching(
  workspace: ImportWorkspaceView,
  draft: OrderDraft,
  onSave: (mapping: ImportMapping) => Promise<ImportWorkspaceView | null>,
) {
  const [matches, setMatches] = useState<ImportMatchData | null>(null),
    [readError, setReadError] = useState('');
  const [mapping, setMapping] = useState(() => normalized(workspace.mapping, draft));
  const [invalidated, setInvalidated] = useState<MappingInvalidations>(
    workspace.mappingInvalidated || { products: {} },
  );
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    workspace.mapping ? 'saved' : 'idle',
  );
  const [saveError, setSaveError] = useState('');
  const mappingRef = useRef(mapping),
    invalidRef = useRef(invalidated),
    priorDraft = useRef(draft),
    live = useRef(true),
    saving = useRef(false),
    customerTouched = useRef(false);
  const savedRef = useRef(normalized(workspace.mapping, draft));
  const candidateCache = useRef(
    new Map<
      string,
      {
        key: string;
        products: ImportMatchData['products'];
        value: ReturnType<typeof productCandidatesForLine>;
      }
    >(),
  );
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const update = (next: ImportMapping, notices = invalidRef.current) => {
    mappingRef.current = next;
    invalidRef.current = notices;
    setMapping(next);
    setInvalidated(notices);
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    const localDirty = JSON.stringify(mappingRef.current) !== JSON.stringify(savedRef.current);
    savedRef.current = normalized(workspace.mapping, draft);
    if (!localDirty && !saving.current) {
      update(savedRef.current, workspace.mappingInvalidated || { products: {} });
      setSaveState(workspace.mapping ? 'saved' : 'idle');
    }
  }, [workspace.revision]);
  useEffect(() => {
    const next = invalidateImportMapping(
      mappingRef.current,
      priorDraft.current,
      draft,
      invalidRef.current,
    );
    priorDraft.current = draft;
    if (
      JSON.stringify(next.mapping) !== JSON.stringify(mappingRef.current) ||
      JSON.stringify(next.invalidated) !== JSON.stringify(invalidRef.current)
    ) {
      update(next.mapping!, next.invalidated);
      setSaveState('idle');
      setSaveError('');
    }
  }, [draft]);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    fetch('/api/ai/imports/' + workspace.id + '/matches', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw Error(data.message || '读取失败');
        return data as ImportMatchData;
      })
      .then((data) => {
        if (current && data.revision === workspace.revision) {
          setMatches(data);
          setReadError('');
        }
      })
      .catch((e) => {
        if (current && e.name !== 'AbortError') setReadError(e.message);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [workspace.id, workspace.revision]);
  const customerResolution = useMemo(() => {
    if (!matches) return null;
    return matches.revision === workspace.revision &&
      importNameKey(draft.header.buyerName.value || '') ===
        importNameKey(workspace.draft?.header.buyerName.value || '')
      ? matches.customerResolution
      : resolveCustomerCandidates(matches.customerRecords, draft.header.buyerName.value || '');
  }, [matches, draft.header.buyerName.value, workspace.draft]);
  useEffect(() => {
    if (
      customerResolution?.state === 'resolved' &&
      mappingRef.current.customer.mode === 'pending' &&
      !invalidRef.current.customer &&
      !customerTouched.current
    ) {
      const c = customerResolution.customer!;
      update({
        ...mappingRef.current,
        customer: { mode: 'existing', id: c.id, version: c.version },
      });
      setSaveState('idle');
    }
  }, [customerResolution]);
  const candidates = useMemo(
    () =>
      Object.fromEntries(
        draft.lines.map((l) => {
          const products = matches?.products || [],
            key = productMatchKey(l),
            cached = candidateCache.current.get(l.id);
          if (cached?.key === key && cached.products === products) return [l.id, cached.value];
          const value = productCandidatesForLine(l, products);
          candidateCache.current.set(l.id, { key, products, value });
          return [l.id, value];
        }),
      ),
    [draft, matches],
  );
  const select = (next: ImportMapping, kind: 'customer' | string) => {
    const notices = structuredClone(invalidRef.current);
    if (kind === 'customer') {
      customerTouched.current = true;
      delete notices.customer;
    } else delete notices.products[kind];
    update(next, notices);
    setSaveState('idle');
    setSaveError('');
  };
  async function save() {
    if (saving.current) return;
    saving.current = true;
    setSaveState('saving');
    setSaveError('');
    const snapshot = mappingRef.current;
    try {
      const result = await onSave(structuredClone(snapshot));
      if (!live.current) return;
      if (!result) throw Error('保存失败，当前选择已保留，请重试。');
      if (result.revision < workspaceRef.current.revision)
        throw Error('工作区已有后续修订，当前选择已保留，请核对后再保存。');
      // A delayed response must not replace a more recent local selection.
      if (mappingRef.current === snapshot) {
        update(normalized(result.mapping, draft), result.mappingInvalidated || { products: {} });
        setSaveState('saved');
      } else setSaveState('idle');
    } catch (e) {
      if (live.current) {
        setSaveError((e as Error).message);
        setSaveState('error');
      }
    } finally {
      saving.current = false;
    }
  }
  const dirty = JSON.stringify(mapping) !== JSON.stringify(normalized(workspace.mapping, draft));
  const unresolved =
    !!invalidated.customer ||
    Object.keys(invalidated.products).length > 0 ||
    (mapping.customer.mode === 'pending' && customerResolution?.state === 'ambiguous') ||
    (!!matches &&
      mapping.customer.mode === 'existing' &&
      !matches.customers.some(
        (c) =>
          c.id === (mapping.customer as any).id && c.version === (mapping.customer as any).version,
      )) ||
    (!!matches &&
      Object.values(mapping.products).some(
        (choice) =>
          choice.mode === 'existing' &&
          !matches.products.some((p) => p.id === choice.id && p.version === choice.version),
      )) ||
    draft.lines.some(
      (l) =>
        (!mapping.products[l.id] || mapping.products[l.id].mode === 'pending') &&
        candidates[l.id]?.length > 0,
    );
  return {
    matches,
    readError,
    mapping,
    invalidated,
    customerResolution,
    candidates,
    select,
    save,
    saveState,
    saveError,
    dirty,
    unresolved,
  };
}

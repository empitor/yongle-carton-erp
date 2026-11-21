import { useEffect, useEffectEvent, useRef, useState, type SubmitEvent } from 'react';
import { z } from 'zod';
import { errorMessage, type Product } from '../../shared/core/index';
import { stockKinds, type StockItemView } from '../../shared/business/index';
import { EditorFooter, FormMessage, Hint, ManagementDialog, textField } from '../ui/index';
import { readProductStock, readStockItem, saveStockItem } from '../warehouse/stock-api';
import { blankStock } from './purchase-seed';
import { FinishedSpec, ProductPicker, RawFields, StockNotes, fromProduct, type StockForm } from './StockEditorFields';

const FORM_ID = 'stock-editor-form';

/** 已有的那个库存品（撞上“同一种货只有一个库存”时给“打开它”） */
type Existing = { stockId: number; name: string; kind: StockItemView['kind']; archived: boolean };
/** 选的产品已经有成品库存（不是正在编辑的这一个） */
type Conflict = Existing & { productName: string };

const existingHref = (e: Existing) => '#warehouse?kind=' + e.kind + '&record=' + e.stockId;

/** 保存时撞上已有的库存品：服务端 409、code 是 stock-exists，details 带着已有那个的编号、名称、种类、是否归档 */
const stockConflict = z.object({
  details: z.object({ stockId: z.number().int(), name: z.string(), kind: z.enum(stockKinds), archived: z.boolean() }),
});
function existingStock(e: unknown): Existing | null {
  if (!(e instanceof Error) || !('data' in e) || textField(e, 'code') !== 'stock-exists') return null;
  const parsed = stockConflict.safeParse(e.data);
  return parsed.success ? parsed.data.details : null;
}

/** 编辑已有的成品：用过的（有出入库记录或被单据引用）不能换产品，读一下再决定产品能不能改；读到之前是 null（先不让改） */
function useUsedCheck(stockId: number | undefined, finished: boolean) {
  const [used, setUsed] = useState<boolean | null>(stockId !== undefined && finished ? null : false);
  useEffect(() => {
    if (stockId === undefined || !finished) return;
    let live = true;
    readStockItem(stockId)
      .then((row) => live && setUsed(row.used))
      // 读不到就照常让改，保存时服务端还会拦
      .catch(() => live && setUsed(false));
    return () => {
      live = false;
    };
  }, [stockId, finished]);
  return used;
}

/** 选了产品就查它是不是已经有成品库存；换了产品后旧请求晚回来不算 */
function useProductConflict(productId: number | null, productName: string, stockId: number | undefined) {
  const [conflict, setConflict] = useState<Conflict | null>(null),
    [checking, setChecking] = useState(false);
  const checkSeq = useRef(0);
  // 产品名称只用来写提示：取查的那一刻的，名称变了不再查一遍
  const nameNow = useEffectEvent(() => productName);
  useEffect(() => {
    const seq = ++checkSeq.current;
    setConflict(null);
    if (!productId) {
      setChecking(false);
      return;
    }
    setChecking(true);
    const name = nameNow();
    readProductStock(productId)
      .then((row) => {
        if (seq !== checkSeq.current) return;
        setConflict(
          row && row.id !== stockId
            ? { stockId: row.id, name: row.name, kind: 'finished', archived: row.archived, productName: name }
            : null,
        );
      })
      // 查不到就先不拦，保存时服务端还会再查一遍
      .catch(() => {})
      .finally(() => {
        if (seq === checkSeq.current) setChecking(false);
      });
  }, [productId, stockId]);
  return { conflict, checking };
}

function OpenLink({ to, close }: { to: Existing; close: () => void }) {
  return (
    <a className="stock-open-link" href={existingHref(to)} onClick={close}>
      打开它
    </a>
  );
}

function ConflictHint({ conflict, close }: { conflict: Conflict; close: () => void }) {
  return (
    <Hint tone="warning" role="status">
      产品“{conflict.productName}”已经有成品库存“{conflict.name}”
      {conflict.archived ? '（已归档，打开后恢复就能接着用）' : ''}
      ，一个产品只有一个成品库存，不用再建。
      <OpenLink to={conflict} close={close} />
    </Hint>
  );
}

/** 保存失败的说明；撞上已有的库存品时后面跟“打开它” */
function SaveError({ error, existing, close }: { error: string; existing: Existing | null; close: () => void }) {
  return (
    <FormMessage>
      {error && (
        <>
          {error}
          {existing && (
            <>
              {' '}
              <OpenLink to={existing} close={close} />
            </>
          )}
        </>
      )}
    </FormMessage>
  );
}

/** 窗口标题、副标题和给助手认的模块名：新建按库存页当前的种类，修改按这个库存品 */
function editorHeading(value: StockItemView | undefined, kind: string, finished: boolean) {
  if (!value) return { title: '新建' + (kind === 'raw' ? '原材料' : '成品') + '库存品', subtitle: undefined, module: undefined };
  return {
    title: '编辑库存品',
    subtitle: (finished ? '成品' : '原材料') + ' · 现存 ' + value.quantity + ' ' + value.unit,
    module: finished ? 'finished_inventory' : 'raw_inventory',
  };
}

function StockFooter({ finished, busy, blocked, close }: { finished: boolean; busy: boolean; blocked: boolean; close: () => void }) {
  return (
    <EditorFooter
      note={
        finished
          ? '名称、尺寸、材质、楞型、规格跟着产品，改产品资料时一起改；这里不改库存数量。'
          : '这里不改库存数量；有流水后不能再改实际规格。'
      }
    >
      <button type="button" className="secondary" disabled={busy} onClick={close}>
        取消
      </button>
      <button type="submit" form={FORM_ID} className="primary" disabled={blocked}>
        {busy ? '正在保存…' : '保存库存品'}
      </button>
    </EditorFooter>
  );
}

/**
 * 库存品档案（原材料或成品）编辑窗。只改档案，不改库存数量。
 * 成品先选产品：名称、尺寸、材质、楞型、规格说明跟着产品（服务端保存时按产品填），自己能改的只有备注；
 * 一个产品只有一个成品库存。
 */
export function StockEditor({
  value,
  kind,
  products,
  close,
  saved,
}: {
  value?: StockItemView;
  /** 库存页当前是原材料（raw）还是成品（finished）：新建时按它 */
  kind: string;
  products: Product[];
  close: () => void;
  saved: (item: StockItemView) => void;
}) {
  const finished = (value ? value.kind : kind) === 'finished',
    stockId = value?.id;
  const [form, setForm] = useState<StockForm>(() => value || blankStock(finished ? 'finished' : 'raw')),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    // 保存时撞上已有的库存品（服务端 409 stock-exists）
    [existing, setExisting] = useState<Existing | null>(null);
  const patch = (v: Partial<StockForm>) => setForm((s) => ({ ...s, ...v }));
  const used = useUsedCheck(stockId, finished);
  const productId = finished && form.productId ? form.productId : null;
  const product = productId ? products.find((p) => p.id === productId) : undefined;
  const { conflict, checking } = useProductConflict(productId, product?.name || form.name, stockId);
  const choose = (v: string) => {
    const p = products.find((p) => p.id === Number(v));
    setError('');
    setExisting(null);
    patch(p ? fromProduct(p) : { productId: null });
  };
  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || checking || conflict) return;
    setError('');
    setExisting(null);
    if (finished && !productId) {
      setError('先选是哪个产品的成品库存。');
      return;
    }
    setBusy(true);
    try {
      saved(await saveStockItem(form, stockId));
    } catch (err) {
      setExisting(existingStock(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const heading = editorHeading(value, kind, finished);
  return (
    <ManagementDialog
      title={heading.title}
      subtitle={heading.subtitle}
      size="md"
      close={close}
      busy={busy}
      footer={<StockFooter finished={finished} busy={busy} blocked={busy || checking || !!conflict} close={close} />}
    >
      <form
        id={FORM_ID}
        className="pur-stock-form"
        data-agent-module={heading.module}
        data-agent-record={stockId}
        data-agent-label={value?.name}
        onSubmit={submit}
      >
        <SaveError error={error} existing={existing} close={close} />
        {conflict && <ConflictHint conflict={conflict} close={close} />}
        {finished ? (
          <>
            <ProductPicker {...{ form, product, productId, products, used, choose }} />
            <FinishedSpec form={form} product={product} productId={productId} />
          </>
        ) : (
          <RawFields form={form} patch={patch} saved={value ?? null} />
        )}
        <StockNotes form={form} patch={patch} />
      </form>
    </ManagementDialog>
  );
}

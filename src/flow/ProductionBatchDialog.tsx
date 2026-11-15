import { useRef, type RefObject } from 'react';
import { ManagementDialog } from '../ui/index';
import { MoreMenu } from '../ui/index';
import { EditorFooter, FormField, FormMessage, FormSection } from '../ui/index';
import { today } from '../../shared/core/index';
import type { CatalogLists } from '../recordkit/catalog-api';
import { finishedStockByProduct } from '../recordkit/stock-lookup';
import {
  CompletionDistribution,
  CompletionMaterials,
  CompletionPreview,
} from './CompletionSections';
import CompletionTasks, { type CompletionTask } from './CompletionTasks';
import UntaskedCompletions from './UntaskedCompletions';
import { useProductionBatch, type CompletionResult, type ProductionBatch } from './useProductionBatch';

const FORM_ID = 'production-batch-form';

type StockItem = CatalogLists['items'][number];
type ProductChoice = Pick<CatalogLists['products'][number], 'id' | 'name' | 'archived'>;

/** 纸板、产品的叫法：纸板按编号找名称；任务单里没存产品名时用这个产品的成品库存品的名称（一个产品一个成品库存品）；不挂任务的按产品叫 */
function batchNames(items: readonly StockItem[], products: readonly ProductChoice[]) {
  const raw = items.filter((s) => s.kind === 'raw' && !s.archived);
  const finished = finishedStockByProduct(items);
  return {
    raw,
    stockName: (id: string | number) =>
      raw.find((s) => s.id === Number(id))?.name || items.find((s) => s.id === Number(id))?.name || '纸板',
    productName: (r: CompletionTask) => r.productName || finished.get(r.productId)?.name,
    productOf: (id: number) => products.find((p) => p.id === id)?.name || '产品',
  };
}

/**
 * 登记完工：填做完多少（合格、报废）和这批领了哪些纸板，登记即入库。
 * 从一张任务进来只显示这一张，要一起登记的点“再加任务”；从页头进来列出全部没做完的任务，勾选做完的。
 * 一张任务一步登记；几张任务共用一批纸板时先看领料怎么分，再确认。
 * 没有生产任务的（打样、补做）在“不挂任务的完工”里选产品登记，和任务一起共用这批纸板；登记完工只有这一个窗口。
 * “更多”里：先登记、稍后核对入库——在这个窗口里直接把每一行各存一张待入库的完工单（拆分、用料分摊和直接入库一样），
 * 不动库存，之后在完工记录里逐张核对入库。
 */
export default function ProductionBatchDialog({
  tasks,
  items,
  products,
  taskIds,
  close,
  done,
}: {
  tasks: readonly CompletionTask[];
  items: readonly StockItem[];
  /** 不挂任务的完工选产品用 */
  products: readonly ProductChoice[];
  /** 从任务进来时只带这几张；空的时候列出全部没做完的任务让人勾选 */
  taskIds: number[];
  close: () => void;
  /** 登记成功：r.pending 为 true 是只登记、待核对入库，否则已入库 */
  done: (r: CompletionResult) => void;
}) {
  const b = useProductionBatch({ tasks, taskIds, done });
  const form = useRef<HTMLFormElement>(null);
  const { raw, stockName, productName, productOf } = batchNames(items, products);
  /** 改了内容：先作废看过的分配，再改 */
  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      b.changed();
      set(value);
    };
  return (
    <ManagementDialog
      title="登记完工"
      subtitle={
        b.chosen.length
          ? b.chosen.map((r) => r.number + (productName(r) ? ' ' + productName(r) : '')).join('、')
          : '勾选做完的任务，或登记不挂任务的完工；几行可以一起登记、共用一批纸板'
      }
      size="lg"
      close={close}
      busy={b.busy}
      footer={<BatchFooter b={b} form={form} close={close} />}
    >
      <form
        id={FORM_ID}
        ref={form}
        className="wh-batch-form"
        onSubmit={(e) => {
          e.preventDefault();
          void b.submit(false);
        }}
      >
        <FormMessage>{b.error}</FormMessage>
        <WhenWho b={b} />

        <CompletionTasks
          picking={b.picking}
          rows={b.rows}
          setRows={b.setRows}
          others={b.others}
          productName={productName}
          changed={b.changed}
        />

        <UntaskedCompletions rows={b.untasked} products={products} change={edit(b.setUntasked)} />

        <CompletionMaterials
          materials={b.materials}
          raw={raw}
          change={(i, key, value) => {
            b.changed();
            b.setMaterials((v) => v.map((m, j) => (i === j ? { ...m, [key]: value } : m)));
          }}
          add={() => {
            b.changed();
            b.setMaterials((v) => [...v, { stockId: '', issued: '', returned: '0' }]);
          }}
          remove={(i) => {
            b.changed();
            b.setMaterials((v) => v.filter((_, j) => j !== i));
          }}
        />

        {(b.chosen.length > 1 || b.allocation === 'explicit') && (
          <CompletionDistribution
            allocation={b.allocation}
            setAllocation={edit(b.setAllocation)}
            chosen={b.chosen}
            materials={b.materials.filter((m) => m.stockId)}
            distribution={b.distribution}
            setCell={(key, value) => {
              b.changed();
              b.setDistribution((d) => ({ ...d, [key]: value }));
            }}
            stockName={stockName}
          />
        )}

        <FormSection columns={1}>
          <FormField label="批次备注" span="full" hint="会显示在成品库存的批次里">
            <textarea
              aria-label="批次备注"
              placeholder="这批用的什么料、质量怎样"
              value={b.notes}
              maxLength={2000}
              onChange={(e) => edit(b.setNotes)(e.currentTarget.value)}
            />
          </FormField>
        </FormSection>

        {b.preview && (
          <CompletionPreview
            preview={b.preview}
            rows={b.rows}
            productName={productName}
            productOf={productOf}
            stockName={stockName}
          />
        )}
      </form>
    </ManagementDialog>
  );
}

/** 哪天做完、谁做的：完工日期（不能选以后的日子）、机台操作 */
function WhenWho({ b }: { b: ProductionBatch }) {
  return (
    <FormSection title="哪天做完、谁做的" columns={3}>
      <FormField label="完工日期" required>
        <input
          required
          type="date"
          aria-label="实际完工日期"
          max={today()}
          value={b.date}
          onChange={(e) => {
            b.changed();
            b.setDate(e.currentTarget.value);
          }}
        />
      </FormField>
      <FormField label="机台操作" required>
        <input
          required
          aria-label="实际操作人员"
          maxLength={100}
          value={b.operator}
          onChange={(e) => {
            b.changed();
            b.setOperator(e.currentTarget.value);
          }}
        />
      </FormField>
    </FormSection>
  );
}

/** 底栏：“更多”里先登记稍后核对入库，取消，主按钮（几行共用纸板时先看领料怎么分） */
function BatchFooter({ b, form, close }: { b: ProductionBatch; form: RefObject<HTMLFormElement | null>; close: () => void }) {
  return (
    <EditorFooter
      note={
        b.needsReview
          ? '几行共用纸板：先看领料怎么分，这一步不改库存。'
          : '登记后成品直接入库，领的纸板从库存扣掉。'
      }
    >
      <MoreMenu text="更多" label="登记完工的其他做法">
        <button
          type="button"
          role="menuitem"
          disabled={b.busy || !b.ready}
          onClick={() => {
            // 和主按钮一样先过表单必填检查，再在这个窗口里登记成待入库
            if (form.current?.reportValidity()) void b.submit(true);
          }}
        >
          先登记，稍后核对入库
        </button>
      </MoreMenu>
      <button type="button" className="secondary" disabled={b.busy} onClick={close}>
        取消
      </button>
      <button type="submit" form={FORM_ID} className="primary" disabled={b.busy || !b.ready}>
        {b.busy ? '正在登记…' : b.needsReview ? '看领料怎么分' : '登记完工'}
      </button>
    </EditorFooter>
  );
}

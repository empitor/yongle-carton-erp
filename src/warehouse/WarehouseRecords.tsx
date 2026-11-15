import { Suspense, lazy, useState, type ComponentProps } from 'react';
import { canEditBusiness, useAuthState, notify, LIST_PAGE_SIZE, Pagination, stepper } from '../ui/index';
import FlowDocView from '../flow/FlowDocView';
import FlowDeskDialogs from '../flow/FlowDeskDialogs';
import { ListEmpty } from '../flow/ListParts';
import { useFlowDesk, type FlowDesk } from '../flow/useFlowDesk';
import ReadyToShip from './ReadyToShip';
import WarehouseHeading from './WarehouseHeading';
import WarehouseRecordPanel from './WarehouseRecordPanel';
import WarehouseTable from './WarehouseTable';
import WarehouseToolbar from './WarehouseToolbar';
import {
  docIdOf,
  isFlowDoc,
  partyOf,
  purchaseOfLine,
  statusOf,
  type PurchaseLookup,
  type WarehouseKind,
  type WarehouseRow,
  type WarehouseScope,
} from './warehouse-list';
import PendingBatches from './PendingBatches';
import { useWarehouseList, type WarehouseList } from './useWarehouseList';
import { useWarehouseView } from './useWarehouseView';

// 安排送货只有这一个窗口（按客户分单），点了才加载
const DeliveryPlanDialog = lazy(() => import('./DeliveryPlanDialog'));
/** 可发货里勾好的几行：安排送货窗口带着它们打开 */
type PlanPreset = NonNullable<ComponentProps<typeof DeliveryPlanDialog>['preset']>;

/**
 * 到货、送货页。送货：页头一个“安排送货”，最上面是可发货，下面默认列待送货和送货中（逾期的标红）。
 * 到货：最上面是待到货的订货单，每行“登记到货”就是主操作；AI 识别送货单是次要，没有采购单的到货
 * 在“更多”里；下面默认列全部记录，待处理的排前面。日期条件收在“筛选”里。列表和筛选在 useWarehouseList。
 * 详情的按钮、办理和窗口和单据页同一套（useFlowDesk）：desk.view 是打开的那张单据，面板只管显示。
 */
export default function WarehouseRecords({ kind }: { kind: WarehouseKind }) {
  const auth = useAuthState(),
    canEdit = canEditBusiness(auth);
  // 安排送货窗口：页头进来什么都没选（先选客户），可发货里勾好的带着那几行
  const [planning, setPlanning] = useState<{ preset?: PlanPreset } | null>(null);
  const list = useWarehouseList(kind, auth?.actor?.id);
  const { archivedScope, filtered, scope } = list;
  // 已归档的单据：详情、恢复、删除和单据页同一套（useFlowDesk），另两档用仓库自己的面板
  const desk = useFlowDesk({
    kind,
    setKind: () => {},
    dialogOnly: false,
    rows: list.archivedRows,
    archived: true,
    revision: list.revision,
    shownRows: archivedScope ? list.pageRows.filter(isFlowDoc) : [],
    showBoard: false,
    loading: list.archivedLoading,
    setSelected: () => {},
    setNotice: notify,
  });
  const { open, openError, selected } = useWarehouseView(kind, list, desk);
  const purchaseOf: PurchaseLookup = (l) => purchaseOfLine(list.purchases, l);
  const error = openError || list.error || desk.error;
  return (
    <div className="arrival-warehouse">
      <WarehouseHeading
        kind={kind}
        records={list.records}
        batches={list.batches}
        canEdit={canEdit}
        opening={desk.opening > 0}
        plan={() => setPlanning({})}
        begin={() => void desk.begin()}
      />
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {kind === 'arrival' && scope !== 'archived' && <PendingBatches batches={list.batches} canEdit={!!canEdit} />}
      {kind === 'delivery' && canEdit && scope !== 'archived' && (
        <ReadyToShip
          revision={list.revision}
          create={(customerId, lines) => setPlanning({ preset: { customerId, lines } })}
        />
      )}
      <WarehouseToolbar kind={kind} list={list} closeView={() => desk.setView(null)} />
      <WarehouseListBody
        kind={kind}
        list={list}
        desk={desk}
        canEdit={canEdit}
        open={open}
        purchaseOf={purchaseOf}
        plan={() => setPlanning({})}
      />
      {archivedScope && (
        <FlowDocView
          desk={desk}
          {...stepper(filtered, (r) => r.id, desk.view?.id, (r, i) => {
            open(r);
            list.setPage(Math.floor(i / LIST_PAGE_SIZE) + 1);
          })}
        />
      )}
      {selected && desk.view && (
        <WarehouseRecordPanel
          kind={kind}
          record={selected}
          status={statusOf(kind, selected)}
          purchase={kind === 'arrival' ? selected.lines.map(purchaseOf).find(Boolean) || null : null}
          desk={desk}
          close={() => desk.setView(null)}
          {...stepper(filtered, (r) => r, selected, open)}
        />
      )}
      <FlowDeskDialogs desk={desk} />
      {planning && (
        <Suspense fallback={null}>
          <DeliveryPlanDialog
            preset={planning.preset}
            close={() => setPlanning(null)}
            done={(message) => {
              setPlanning(null);
              notify(message);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

/** 列表区：到货或送货记录表（空着时说为什么、给下一步）、翻页、只读了最近的记录时的提示 */
function WarehouseListBody({
  kind,
  list,
  desk,
  canEdit,
  open,
  purchaseOf,
  plan,
}: {
  kind: WarehouseKind;
  list: WarehouseList;
  desk: FlowDesk;
  canEdit: boolean;
  open: (row: WarehouseRow) => void;
  purchaseOf: PurchaseLookup;
  plan: () => void;
}) {
  const { archivedScope, filtered, scope } = list;
  const searched = !!(list.q || list.filterCount);
  const reading = list.busy || (archivedScope && list.archivedLoading);
  return (
    <section className="panel business-records">
      <div className="table-wrap unified-table-region" tabIndex={0}>
        <WarehouseTable
          kind={kind}
          rows={list.pageRows}
          purchaseOf={purchaseOf}
          partyName={(r) => partyOf(r) || desk.labelRow(r)}
          selected={(r) => !!desk.view && desk.view.id === (archivedScope ? r.id : docIdOf(r))}
          // 已归档的打开单据详情（恢复、删除在那里），另两档打开仓库的面板
          open={open}
        />
        {!filtered.length && (
          <ListEmpty
            text={reading ? '正在读取…' : emptyText(kind, searched, scope)}
            busy={list.busy}
            filtered={searched}
            clear={() => {
              list.setQ('');
              list.clearFilters();
            }}
            next={
              canEdit &&
              kind === 'delivery' &&
              scope === 'open' && (
                <button className="secondary" onClick={plan}>
                  安排送货
                </button>
              )
            }
          />
        )}
      </div>
      <Pagination page={list.page} total={filtered.length} pageSize={LIST_PAGE_SIZE} onChange={list.setPage} />
      {!list.full && list.recentFrom && scope === 'all' && (
        <p className="help-text record-recent-note">
          列出的是还要处理的和 {list.recentFrom} 以后的{kind === 'arrival' ? '到货' : '送货'}记录。
          <button type="button" className="text-button" onClick={() => list.setFull(true)}>
            显示更早的记录
          </button>
        </p>
      )}
    </section>
  );
}

/** 列表空着时说的那句（读取中另说） */
function emptyText(kind: WarehouseKind, searched: boolean, scope: WarehouseScope) {
  const name = kind === 'arrival' ? '到货' : '送货';
  if (scope === 'archived' && !searched) return '没有已归档的' + name + '记录。';
  if (searched) return '没有符合条件的' + name + '记录。';
  if (scope === 'all') return '还没有' + name + '记录。';
  return kind === 'delivery'
    ? '没有待送货、送货中的送货单。'
    : '没有待入库的到货。供应商送货来了，在上面的待到货里点“登记到货”。';
}

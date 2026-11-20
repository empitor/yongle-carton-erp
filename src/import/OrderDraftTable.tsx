import { Fragment, useState, useEffect, useRef, type ReactNode } from 'react';
import { ORDER_LINES_TITLE } from '../recordkit/index';
import {
  fieldLabels,
  headerFields,
  lineFields,
  mappingSchema,
  type DraftField,
  type ImportMapping,
  type ImportWorkspaceView as Workspace,
  type OrderDraft,
} from '../../shared/import/index';
import { roundingPolicies, roundingPolicyLabels } from '../../shared/core/index';
import { useImportMatching } from './useImportMatching';
import { FormField, FormSection } from '../ui/index';
import { CustomerMatch } from './CustomerMatch';
import { ProductMatch } from './ImportMatch';
import { DraftInput, type ChangeField, type DraftKey } from './DraftInput';
import { MappingSaveState, OrderNotices } from './OrderDraftNotices';

const mainHeader = ['buyerName', 'purchaseOrderNumber', 'orderDate', 'deliveryDate'] as const;
const mainLine: readonly string[] = ['productName', 'specification', 'quantity', 'unit', 'unitPrice'];
type Match = ReturnType<typeof useImportMatching>;
type DraftLine = OrderDraft['lines'][number];
/** 画一栏的输入框：明细的带哪一行、第几行 */
type Input = (k: DraftKey, field: DraftField, line?: { line: DraftLine; index: number }) => ReactNode;

/**
 * 选了就保存（以前要多点一次“保存选择”，否则导入按钮是灰的，用户不知道为什么）；
 * 还有没确认完的客户、产品时告诉页面（导入按钮旁边的提示）。
 */
function useMappingAutosave(match: Match, locked: boolean, imported: boolean, onPending?: (pending: boolean) => void) {
  const { mapping, dirty, saveState, unresolved } = match,
    loaded = !!match.matches;
  // save 每次渲染都是新函数：放进 ref 取最新的，只按选择和保存状态的变化决定要不要存
  const latestSave = useRef(match.save);
  useEffect(() => {
    latestSave.current = match.save;
  });
  useEffect(() => {
    if (!locked && !imported && loaded && dirty && saveState === 'idle') void latestSave.current();
  }, [mapping, loaded, locked, imported, dirty, saveState]);
  useEffect(() => onPending?.(!loaded || dirty || unresolved), [loaded, dirty, unresolved, onPending]);
}

/** 客户和订单：主要的几栏、客户档案、金额结算，其他字段收进折叠 */
function OrderHeader({
  draft,
  match,
  workspace,
  locked,
  input,
}: {
  draft: OrderDraft;
  match: Match;
  workspace: Workspace;
  locked: boolean;
  input: Input;
}) {
  const imported = !!workspace.imported,
    { mapping } = match;
  return (
    <FormSection
      title="客户和订单"
      columns={4}
      extra={!imported && <MappingSaveState match={match} saved={!!workspace.mapping} locked={locked} />}
    >
      {mainHeader.map((k) => (
        <FormField key={k} label={fieldLabels[k]}>
          {input(k, draft.header[k])}
        </FormField>
      ))}
      {!imported && <CustomerMatch match={match} buyerName={draft.header.buyerName.value} locked={locked} />}
      <FormField label="金额结算" span={imported ? 'full' : 2}>
        <select
          aria-label="金额结算规则"
          disabled={locked}
          value={mapping.roundingPolicy}
          onChange={(e) => {
            const policy = mappingSchema.shape.roundingPolicy.safeParse(e.target.value);
            if (policy.success) match.select({ ...mapping, roundingPolicy: policy.data }, 'rounding');
          }}
        >
          {roundingPolicies.map((value) => (
            <option key={value} value={value}>
              {roundingPolicyLabels[value]}
            </option>
          ))}
        </select>
      </FormField>
      <details className="aii-more aii-span-full">
        <summary>其他订单字段：供应方、币种、税率、备注、合同条件、原文合计</summary>
        <div className="ed-grid cols-4 aii-compact">
          {headerFields
            .filter((k) => !(mainHeader as readonly string[]).includes(k))
            .map((k) => (
              <FormField key={k} label={fieldLabels[k]}>
                {input(k, draft.header[k])}
              </FormField>
            ))}
        </div>
      </details>
    </FormSection>
  );
}

/** 产品明细：每行主要几栏和程序算的金额，下面一行是产品档案对应到哪，少用的字段收进折叠 */
function OrderLines({
  draft,
  match,
  workspace,
  locked,
  input,
}: {
  draft: OrderDraft;
  match: Match;
  workspace: Workspace;
  locked: boolean;
  input: Input;
}) {
  const imported = !!workspace.imported;
  return (
    <FormSection title={ORDER_LINES_TITLE} columns={1}>
      <div className="aii-lines-wrap">
        <table className="aii-lines">
          <thead>
            <tr>
              <th>产品名称</th>
              <th>规格</th>
              <th>数量 / 单位</th>
              <th className="num">单价 / 元</th>
              <th className="num">计算金额</th>
            </tr>
          </thead>
          <tbody>
            {draft.lines.map((l, i) => {
              const at = { line: l, index: i };
              return (
                <Fragment key={l.id}>
                  <tr className="aii-line-main">
                    <td data-label="产品名称">
                      <div className="aii-line-name">
                        <span className="aii-line-no">{i + 1}</span>
                        {input('productName', l.fields.productName, at)}
                      </div>
                    </td>
                    <td data-label="规格">{input('specification', l.fields.specification, at)}</td>
                    <td data-label="数量 / 单位">
                      <div className="aii-qty">
                        {input('quantity', l.fields.quantity, at)}
                        {input('unit', l.fields.unit, at)}
                      </div>
                    </td>
                    <td className="num" data-label="单价 / 元">
                      {input('unitPrice', l.fields.unitPrice, at)}
                    </td>
                    <td className="num aii-amount" data-label="计算金额">
                      {workspace.evaluation?.lineAmounts[l.id] || '待核对'}
                      <small>原文 {l.fields.statedAmount.value || '—'}</small>
                    </td>
                  </tr>
                  <tr className="aii-line-sub">
                    <td colSpan={5}>
                      {!imported && <ProductMatch match={match} lineId={l.id} index={i} locked={locked} />}
                      <details className="aii-more">
                        <summary>备注、编码、尺寸、配纸等</summary>
                        <div className="ed-grid cols-4 aii-compact">
                          {lineFields
                            .filter((k) => !mainLine.includes(k))
                            .map((k) => (
                              <FormField key={k} label={fieldLabels[k]} span={k === 'notes' || k === 'requirements' ? 2 : 1}>
                                {input(k, l.fields[k], at)}
                              </FormField>
                            ))}
                        </div>
                      </details>
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </FormSection>
  );
}

/**
 * 订单草稿核对：上面“客户和订单”，下面“产品明细”。每行明细下面一行写产品档案对应到哪，
 * 少用的字段（备注、编码、配纸）收进这一行的折叠里。所有内容都可以改。
 */
export default function OrderDraftTable({
  workspace,
  draft,
  locked: externallyLocked,
  change,
  onMapping,
  onMappingPending,
  mappingError,
}: {
  workspace: Workspace;
  draft: OrderDraft;
  locked: boolean;
  change: ChangeField;
  onMapping: (m: ImportMapping) => Promise<Workspace | null>;
  onMappingPending?: (pending: boolean) => void;
  mappingError?: string;
}) {
  const match = useImportMatching(workspace, draft, onMapping);
  const locked = externallyLocked || match.saveState === 'saving';
  useMappingAutosave(match, locked, !!workspace.imported, onMappingPending);
  const [dimensionError, setDimensionError] = useState('');
  const input: Input = (k, field, line) => (
    <DraftInput k={k} field={field} line={line} locked={locked} change={change} setDimensionError={setDimensionError} />
  );
  return (
    <div className="aii-order">
      <OrderNotices match={match} workspace={workspace} mappingError={mappingError} dimensionError={dimensionError} />
      <OrderHeader draft={draft} match={match} workspace={workspace} locked={locked} input={input} />
      <OrderLines draft={draft} match={match} workspace={workspace} locked={locked} input={input} />
    </div>
  );
}

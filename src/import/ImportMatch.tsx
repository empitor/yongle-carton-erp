import { productCustomerIssue, productFitsCustomer } from '../../shared/core/index';
import { blocksNewProduct, productCandidateDetails } from '../../shared/import/index';
import type { ImportMapping, ImportMatchData } from '../../shared/import/index';
import { StatusChip, type Tone, loadingText } from '../ui/index';
import type { useImportMatching } from './useImportMatching';

export type Match = ReturnType<typeof useImportMatching>;
type Choice = ImportMapping['products'][string];
type CustomerChoice = ImportMapping['customer'];
type ProductRecord = ImportMatchData['products'][number];
type Candidate = Match['candidates'][string][number];

/** 下拉选的值变成选择：new 是新建，空是待确认，别的是档案编号（取下拉里那一份的版本号） */
export const selectChoice = (value: string, items: { id: number; version: number }[]) => {
  if (value === 'new') return { mode: 'new' as const };
  const item = value ? items.find((i) => i.id === Number(value)) : undefined;
  return item ? { mode: 'existing' as const, id: item.id, version: item.version } : { mode: 'pending' as const };
};
export const choiceValue = (c: Choice | CustomerChoice | undefined) =>
  c?.mode === 'existing' ? String(c.id) : c?.mode === 'new' ? 'new' : '';

/**
 * 一行产品那一格的状态：标签、颜色、一句说明。customer 是这张订单选定的客户（新客户没有编号；名字取客户档案，没有就是空），
 * 属别家客户时那句和下单、导入、助手报的是同一句（productCustomerIssue）。
 */
export function productStatus(
  choice: Choice | undefined,
  found: { product?: ProductRecord; unavailable: boolean; customer: { id: number | null; name?: string }; loaded: boolean; list: Candidate[] },
): { tone: Tone; chip: string; text: string } {
  const { product, unavailable, customer, loaded, list } = found;
  if (choice?.mode === 'existing') {
    const issue = product && productCustomerIssue(product, customer);
    if (issue) return { tone: 'danger', chip: '归属冲突', text: issue };
    if (unavailable) return { tone: 'danger', chip: '已失效', text: '原产品选择已失效，请重新选择' };
    if (!product) return { tone: 'neutral', chip: '已匹配', text: loadingText('档案') };
    const details = productCandidateDetails(product);
    const missing = [!product.material?.trim() ? '材质' : '', !product.flute?.trim() ? '楞型' : ''].filter(Boolean);
    return missing.length
      ? { tone: 'warning', chip: '资料不全', text: details + ' · 缺少' + missing.join('、') + '（允许后补）' }
      : { tone: 'success', chip: '已匹配', text: details };
  }
  if (choice?.mode === 'new') return { tone: 'neutral', chip: '计划新建', text: '导入时新建产品，现在不建档' };
  if (list.some(blocksNewProduct))
    return {
      tone: 'warning',
      chip: '待确认',
      text: list.length > 1 ? '有多个候选，请按规格、料号及差异核对' : '找到候选，请确认',
    };
  if (!loaded) return { tone: 'neutral', chip: '读取中', text: loadingText('产品候选') };
  return {
    tone: 'neutral',
    chip: '导入时新建',
    text: list.length ? '没有同名档案；如果是下面这款，请点确认' : '没有匹配档案',
  };
}

/** 还没定的一行：前 4 个候选逐个列出来确认，多的在下拉里看 */
function ProductCandidates({
  n,
  list,
  products,
  pendingMore,
  locked,
  pick,
}: {
  n: number;
  list: Candidate[];
  products: ProductRecord[];
  /** 待确认（不是还没选）时，多出来的候选说一句 */
  pendingMore: boolean;
  locked: boolean;
  pick: (next: Choice) => void;
}) {
  const shown = list.slice(0, 4).flatMap((c) => {
    const p = products.find((x) => x.id === c.id);
    return p ? [{ c, p }] : [];
  });
  return (
    <div className="aii-candidates">
      {shown.map(({ c, p }) => (
        <div className={'aii-candidate' + (c.recommended ? ' is-recommended' : '')} key={c.id}>
          <div>
            <strong>
              {c.name}
            </strong>
            <small>{productCandidateDetails(p)}</small>
            <small>{c.reasons.join('、')}</small>
            {!!c.conflicts.length && <small className="aii-text-danger">需核对：{c.conflicts.join('、')}</small>}
          </div>
          <button
            type="button"
            className="secondary"
            disabled={locked}
            aria-label={'明细' + n + ' 确认产品候选 ' + c.name}
            onClick={() => pick({ mode: 'existing', id: p.id, version: p.version })}
          >
            确认此候选
          </button>
        </div>
      ))}
      {pendingMore && list.length > 4 && (
        <small className="aii-muted">另有 {list.length - 4} 个候选，可以在上面的下拉里查看。</small>
      )}
    </div>
  );
}

/** 产品下拉：只显示实际已选值，不把未确认的推荐候选伪装成已选 */
function ProductSelect({
  n,
  choice,
  list,
  products,
  allProducts,
  loaded,
  locked,
  pick,
}: {
  n: number;
  choice: Choice | undefined;
  list: Candidate[];
  products: ProductRecord[];
  allProducts: ProductRecord[];
  loaded: boolean;
  locked: boolean;
  pick: (next: Choice) => void;
}) {
  const chosenId = choice?.mode === 'existing' ? choice.id : undefined;
  const shown =
    chosenId && !products.some((p) => p.id === chosenId)
      ? [...allProducts.filter((p) => p.id === chosenId), ...products]
      : products;
  return (
    <select
      aria-label={'明细' + n + ' 产品匹配'}
      value={choiceValue(choice)}
      disabled={locked || !loaded}
      onChange={(e) => pick(selectChoice(e.target.value, shown))}
    >
      <option value="">待确认</option>
      <option value="new">计划创建新产品</option>
      {shown.map((p) => (
        <option key={p.id} value={p.id}>
          {chosenId === p.id ? '已选择 · ' : list.some((x) => x.id === p.id) ? '候选 · ' : ''}
          {productCandidateDetails(p)}
        </option>
      ))}
    </select>
  );
}

/** 选了已有档案时是哪一个，那份档案还在不在、版本对不对得上、是不是属别家客户 */
function chosenProduct(choice: Choice | undefined, matches: ImportMatchData | null, customerId: number | null) {
  if (choice?.mode !== 'existing') return { product: undefined, unavailable: false, wrongCustomer: false };
  const product = matches?.products.find((p) => p.id === choice.id);
  const wrongCustomer = Boolean(product && !productFitsCustomer(product, customerId));
  return { product, unavailable: !!matches && (!product || product.version !== choice.version), wrongCustomer };
}

/** 一行明细对应哪个产品档案：一个状态标签、一句说明、一个下拉；没定时把候选列出来确认。 */
export function ProductMatch({
  match,
  lineId,
  index,
  locked,
}: {
  match: Match;
  lineId: string;
  index: number;
  locked: boolean;
}) {
  const { matches, customerId, eligibleProducts, mapping, invalidated, candidates: all } = match;
  const n = index + 1,
    choice: Choice | undefined = mapping.products[lineId],
    list = all[lineId] || [];
  const pick = (next: Choice) => match.select({ ...mapping, products: { ...mapping.products, [lineId]: next } }, lineId);
  const { product, unavailable, wrongCustomer } = chosenProduct(choice, matches, customerId);
  const pending = choice?.mode !== 'existing' && choice?.mode !== 'new';
  const customer = { id: customerId, name: matches?.customers.find((c) => c.id === customerId)?.name };
  const status = productStatus(choice, { product, unavailable, customer, loaded: !!matches, list });
  return (
    <div className="aii-match" aria-label={'明细' + n + ' 产品档案匹配'}>
      <div className="aii-match-row">
        <span className="aii-match-label">产品档案</span>
        <StatusChip tone={status.tone}>{status.chip}</StatusChip>
        <span className="aii-match-text" title={status.text}>
          {status.text}
        </span>
        {unavailable && !wrongCustomer && product && (
          <button
            type="button"
            className="secondary"
            disabled={locked}
            onClick={() => pick({ mode: 'existing', id: product.id, version: product.version })}
          >
            重新确认此产品
          </button>
        )}
        <ProductSelect
          n={n}
          choice={choice}
          list={list}
          products={eligibleProducts}
          allProducts={matches?.products || []}
          loaded={!!matches}
          locked={locked}
          pick={pick}
        />
      </div>
      {invalidated.products[lineId] && choice?.mode === 'pending' && (
        <small className="aii-match-error" role="alert">
          {invalidated.products[lineId]}
        </small>
      )}
      {pending && list.length > 0 && matches && (
        <ProductCandidates
          n={n}
          list={list}
          products={matches.products}
          pendingMore={choice?.mode === 'pending'}
          locked={locked}
          pick={pick}
        />
      )}
    </div>
  );
}

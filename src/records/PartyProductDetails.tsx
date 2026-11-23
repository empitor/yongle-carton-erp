import { Facts, FormMessage, Hint, Loading, Section, useLoad } from '../ui/index';
import ContactSection from '../recordkit/ContactSection';
import ProductMarks from '../marks/ProductMarks';
import { formatDimensions, dimensionKeys, normalizeDimensionUnit, pageHref, plainPrice, priceFromCents } from '../../shared/core/index';
import RelatedOrderList from './RelatedOrderList';
import { loadCustomerProducts } from './list-api';
import { useRecordContext } from '../recordkit/record-meta';
import { useProductFamily } from '../recordkit/useProductFamily';
import type { RecordRowOf } from './record-rows';

type Sized = Parameters<typeof formatDimensions>[0];
type Priced = { priceExact?: string | null; priceCents?: number | null };
const PRODUCTS_SHOWN = 20;

/** 客户详情里的“产品”一节：列出属于这家客户的产品，点开看详情，多的时候点“全部产品”跳产品页 */
function CustomerProductList({ customerId }: { customerId: number }) {
  const loaded = useLoad(String(customerId), () => loadCustomerProducts(customerId));
  const products = loaded.loading || loaded.error ? null : loaded.data,
    error = loaded.loading ? '' : loaded.error;
  return (
    <Section
      title={'产品' + (products ? ' ' + products.length : '')}
      extra={
        products && products.length > 0 ? (
          <a className="sales-section-link" href={pageHref('products', { customerId })}>
            全部产品
          </a>
        ) : undefined
      }
    >
      {error ? (
        <FormMessage>{error}</FormMessage>
      ) : !products ? (
        <Loading what="产品" />
      ) : !products.length ? (
        <p className="sales-muted">还没有指定给这家客户的产品。</p>
      ) : (
        <ul className="sales-order-links">
          {products.slice(0, PRODUCTS_SHOWN).map((p) => (
            <li key={p.id}>
              <a href={pageHref('products', { record: p.id })}>{p.name}</a>
              <small>{[productSize(p), p.material, p.flute].filter(Boolean).join(' / ') || '规格待补充'}</small>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** 客户详情：怎么联系，后面是这个客户的产品和订单。 */
export function CustomerDetail({ row }: { row: RecordRowOf['customers'] }) {
  useRecordContext('customers', row.id, row.name);
  return (
    <div data-agent-module="customers" data-agent-record={row.id} data-agent-label={row.name}>
      <ContactSection row={row} />
      <CustomerProductList key={'cp' + row.id} customerId={row.id} />
      <RelatedOrderList
        key={'c' + row.id}
        query={{ customerId: row.id }}
        moreHref={pageHref('orders', { customerId: row.id, scope: 'all' })}
        moreLabel="全部订单"
      />
    </div>
  );
}

/** 尺寸：一个都没填时显示“—”，否则照原样写，单位没确认的会注明。 */
export function productSize(row: Sized) {
  return dimensionKeys.every((k) => row[k] == null) && !row.dimensionUnit
    ? ''
    : formatDimensions(row);
}

/**
 * 参考单价（不带“元”）：列表和详情同一个写法，按全站单价写法（plainPrice：至少两位、最多四位，尾零去掉）；
 * 没定过价（0 且没有精确单价）的返回空，不把 0 当成价格。
 */
export function productPrice(row: Priced) {
  if (row.priceExact) return plainPrice(String(row.priceExact));
  return row.priceCents ? plainPrice(priceFromCents(row.priceCents)) : '';
}

/** 产品资料还缺哪几样（和“资料不全”的判断一致：尺寸和单位、材质、楞型）。 */
function productMissing(row: RecordRowOf['products']) {
  const missing: string[] = [];
  if (!dimensionKeys.every((k) => typeof row[k] === 'number' && row[k] > 0)) missing.push('长宽高');
  if (!normalizeDimensionUnit(row.dimensionUnit)) missing.push('尺寸单位');
  if (!row.material.trim()) missing.push('材质');
  if (!row.flute.trim()) missing.push('楞型');
  return missing;
}

/** 产品详情：规格资料、唛头、相关订单。 */
export function ProductDetail({ row }: { row: RecordRowOf['products'] }) {
  useRecordContext('products', row.id, row.name);
  const missing = productMissing(row);
  // 附属关系只是显示上归在一起：订单、价格、库存各算各的
  const family = useProductFamily(),
    parentId = row.parentProductId ?? family.parentOf(row.id),
    children = family.childrenOf(row.id);
  return (
    <div data-agent-module="products" data-agent-record={row.id} data-agent-label={row.name}>
      {missing.length > 0 && (
        <Hint tone="warning">资料不全，还缺{missing.join('、')}。不影响下单，补全后排产和订料更准。</Hint>
      )}
      {row.customerId == null && !!row.orderedCustomers?.length && (
        <Hint tone="warning">
          还没定所属客户，历史上给 {row.orderedCustomers.join('、')} 下过单；点“编辑”选定客户后只出现在该客户的订单里。
        </Hint>
      )}
      <Section title="规格">
        <Facts
          items={[
            {
              label: '客户',
              value: row.customerId ? (
                <a href={pageHref('customers', { record: row.customerId })}>{row.customerName || '查看'}</a>
              ) : (
                '未指定（所有客户都能选）'
              ),
            },
            { label: '尺寸', value: productSize(row) },
            {
              label: '附属于',
              value: parentId ? <a href={pageHref('products', { record: parentId })}>{family.nameOf(parentId) || '查看'}</a> : null,
              hidden: !parentId,
            },
            { label: '客户料号', value: row.customerProductCode },
            { label: '材质 / 配纸', value: row.material },
            { label: '楞型', value: row.flute },
            { label: '参考单价', value: productPrice(row) ? productPrice(row) + ' 元' : '' },
            { label: '加工要求', value: row.requirements, wide: true },
          ]}
        />
      </Section>
      {children.length > 0 && (
        <Section title="附属品">
          <ul className="record-family-list">
            {children.map((c, i) => (
              <li key={c.id}>
                <span
                  className={'record-tree-branch' + (i === children.length - 1 ? ' is-last' : '')}
                  aria-hidden="true"
                />
                <a href={pageHref('products', { record: c.id })}>{c.name}</a>
              </li>
            ))}
          </ul>
          <p className="help-text">挂在这个产品下面，只是看着清楚；订单、价格、库存还是各算各的。</p>
        </Section>
      )}
      <div className="record-section">
        <ProductMarks key={'m' + row.id} productId={row.id} />
      </div>
      <RelatedOrderList key={'p' + row.id} query={{ productId: row.id }} />
    </div>
  );
}

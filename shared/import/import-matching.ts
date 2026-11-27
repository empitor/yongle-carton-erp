import type { Customer, Product } from '../core/index.js';
import type { ImportMapping, MappingInvalidations } from './import-mapping.js';
import type { OrderDraft } from './order-draft.js';
import { dimensionKeys, dimensionValueSchema, normalizeDimensionUnit, normalizedDimensions, formatDimensions, parseDimension, nameKey, productsForCustomer } from '../core/index.js';

/** 识别结果对应客户、产品时比名字用的键（shared/core/name-keys.ts 的 nameKey） */
export const importNameKey = nameKey;
const specKey = (s: string) => importNameKey(s).replace(/[x*]/g, '×');
/** 两段文字有多像（0 到 1）。用来发现错别字和少字，只用于列候选，不单凭它自动合并。 */
export function nameSimilarity(a: string, b: string) {
  // 名字里的数字不同（1厂和2厂、甲1和甲3）基本就是两个不同的档案，再像也不算
  const digits = (s: string) => (s.match(/\d+/g) || []).join();
  if (digits(a) !== digits(b)) return 0;
  const grams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) out.set(s.slice(i, i + 2), (out.get(s.slice(i, i + 2)) || 0) + 1);
    return out;
  };
  const x = grams(a),
    y = grams(b);
  const total = Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0);
  if (!total) return a === b ? 1 : 0;
  let shared = 0;
  for (const [k, n] of x) shared += Math.min(n, y.get(k) || 0);
  return (2 * shared) / total;
}
const CUSTOMER_SIMILAR = 0.65;
// 尺寸相同时才比名字像不像。比较时去掉括号内容，否则“（电商）”这种后缀会让不同产品显得很像。
const PRODUCT_SIMILAR = 0.5;
const bareName = (key: string) => key.replace(/\([^)]*\)/g, '');
const MIN_CONTAINED = 4;
const sameNumbers = (a: string, b: string) =>
  (a.match(/\d+/g) || []).join() === (b.match(/\d+/g) || []).join();
export type CustomerRecord = Pick<
  Customer,
  'id' | 'name' | 'version' | 'contact' | 'phone' | 'address'
> & { archived?: boolean };
export function resolveCustomerCandidates(
  inputRecords: CustomerRecord[],
  name: string,
  historyIds: number[] = [],
  confirmedIds: number[] = [],
) {
  const records = inputRecords.map(({ id, name, version, contact, phone, address, archived }) => ({
    id,
    name,
    version,
    contact,
    phone,
    address,
    archived,
  }));
  const key = importNameKey(name);
  // 去掉公司后缀、括号、盖章字样后的名字。这些相同就是同一家。
  const similar = (s: string) =>
    importNameKey(s)
      .replace(/有限责任公司|有限公司|公司/g, '')
      .replace(/盖章|公章/g, '')
      .replace(/[()]/g, '');
  const exact = records.filter(
    (c) => !!key && (importNameKey(c.name) === key || historyIds.includes(c.id)),
  );
  const fuzzy = records.filter((c) => {
    const a = similar(c.name),
      b = similar(name);
    return (
      !!a && !!b && (a.includes(b) || b.includes(a) || nameSimilarity(a, b) >= CUSTOMER_SIMILAR)
    );
  });
  const same = records.filter((c) => !!similar(name) && similar(c.name) === similar(name));
  // 只差“有限公司”这类后缀的唯一档案直接并入；错别字、少字列为候选问一下，不静默新建重复客户。
  // 同名既有归档也有在用的，就是在用那个。
  const active = exact.filter((c) => !c.archived);
  const proven = exact.length
    ? active.length === 1
      ? active
      : exact
    : same.length === 1
      ? same
      : fuzzy.filter((c) => confirmedIds.includes(c.id));
  const candidates = [
    ...new Map(
      [...exact, ...fuzzy].map((c) => [
        c.id,
        {
          ...c,
          reason: exact.some((e) => e.id === c.id)
            ? '名称排版一致或历史订单身份一致'
            : same.some((e) => e.id === c.id)
              ? '只差公司后缀或括号'
              : '名称相近，身份尚需核对',
        },
      ]),
    ).values(),
  ];
  if (proven.length === 1)
    return {
      state: proven[0].archived ? ('archived' as const) : ('resolved' as const),
      customer: proven[0],
      candidates,
    };
  return {
    state: candidates.length ? ('ambiguous' as const) : ('new' as const),
    customer: undefined,
    candidates,
  };
}
export type ProductCandidate = {
  id: number;
  name: string;
  reasons: string[];
  conflicts: string[];
  recommended: boolean;
  missing: string[];
};
export type ImportMatchData = {
  revision: number;
  customers: Customer[];
  customerRecords: CustomerRecord[];
  products: Product[];
  customerResolution: ReturnType<typeof resolveCustomerCandidates>;
  customerCandidates: ReturnType<typeof resolveCustomerCandidates>['candidates'];
  productCandidates: Record<string, ProductCandidate[]>;
  duplicateOrders: { id: number; number: string; customerName: string }[];
};
type Line = OrderDraft['lines'][number];
function lineDimensions(line: Line) {
  const f = line.fields;
  const explicit = dimensionKeys.map((k) => {
    try {
      return parseDimension(f[k].value);
    } catch {
      return NaN;
    }
  });
  const unit = normalizeDimensionUnit(f.dimensionUnit.value);
  // 规格原文里的三边尺寸：既抓已知单位，也抓无法识别的非空单位后缀（如 in / 英寸），避免把不认得的单位静默吞掉
  const tuple = (f.specification.value || '')
    .normalize('NFKC')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*[×x*]\s*(\d+(?:\.\d+)?)\s*[×x*]\s*(\d+(?:\.\d+)?)\s*([^\d\s×x*]+)?$/i);
  const rawSpecUnit = (tuple?.[4] || '').trim();
  const specUnit = normalizeDimensionUnit(rawSpecUnit);
  const specUnitUnknown = Boolean(rawSpecUnit && !specUnit);
  const specUnitConflict = Boolean(unit && specUnit && unit !== specUnit);
  const tupleUnit = specUnit || (!specUnitUnknown && explicit.every((v) => v === null) ? unit : null);
  const tupleValues = tuple ? [tuple[1], tuple[2], tuple[3]].map(Number) : null;
  const rawTuple =
    tupleValues && tupleValues.every((n) => dimensionValueSchema.safeParse(n).success) ? tupleValues : null;
  const fromTuple =
    rawTuple && tupleUnit
      ? normalizedDimensions({
          length: rawTuple[0],
          width: rawTuple[1],
          height: rawTuple[2],
          dimensionUnit: tupleUnit,
        })
      : null;
  const safe = explicit.map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : null));
  const values = normalizedDimensions({
    length: safe[0],
    width: safe[1],
    height: safe[2],
    dimensionUnit: unit,
  });
  return { unit, values, explicit, fromTuple, tupleUnit, rawTuple, specUnitUnknown, specUnitConflict };
}
/**
 * 这个候选是否强到必须先确认才能新建。纸箱厂常有尺寸相同、名字不同的产品，光尺寸相同不算，
 * 否则两款不同的产品会互相拦住。同名、同料号，或尺寸、材质、楞型都相同才算。
 */
export function blocksNewProduct(c: ProductCandidate) {
  const has = (text: string) => c.reasons.some((r) => r.startsWith(text));
  return (
    has('名称一致') ||
    has('名称很像') ||
    has('客户料号一致') ||
    (has('尺寸一致') && has('材质一致') && has('楞型一致'))
  );
}
type LineFacts = { f: Line['fields']; dims: ReturnType<typeof lineDimensions>; name: string };
type Notes = { reasons: string[]; conflicts: string[] };
const dimensionConflicts: Record<(typeof dimensionKeys)[number], string> = {
  length: '长不一致',
  width: '宽不一致',
  height: '高不一致',
};
/** 写了就要和档案对得上的几项；材质、楞型档案里空着的列为“缺” */
const comparedAttributes = [
  ['material', '材质'],
  ['flute', '楞型'],
  ['productCode', '客户料号'],
] as const;
const requiredAttributes = [
  ['material', '材质'],
  ['flute', '楞型'],
] as const;
/** 名称、料号对不对得上：同名、名称互相包含、名称很像、客户料号一致 */
function identityMatch({ f, name }: LineFacts, p: Product) {
  const pName = importNameKey(p.name);
  const sameName = !!name && pName === name;
  const contained =
    !sameName && Math.min(name.length, pName.length) >= MIN_CONTAINED && (name.includes(pName) || pName.includes(name));
  const close = !sameName && !contained && !!name && nameSimilarity(bareName(name), bareName(pName)) >= PRODUCT_SIMILAR;
  const sameCode =
    !!f.productCode.value &&
    !!p.customerProductCode &&
    importNameKey(p.customerProductCode) === importNameKey(f.productCode.value);
  return { pName, sameName, contained, close, sameCode };
}
/** 单位都明确：按换算后的尺寸逐边比，交回三边是否都一致 */
function unitDimensionsMatch(dims: LineFacts['dims'], values: ReturnType<typeof normalizedDimensions>, notes: Notes) {
  dimensionKeys.forEach((k, i) => {
    if (dims.explicit[i] !== null && values[i] !== null && values[i] !== dims.values[i])
      notes.conflicts.push(dimensionConflicts[k]);
  });
  return dims.values.every((v, i) => v !== null && Number.isFinite(v) && v === values[i]);
}
/** 尺寸算不算同一个：单位明确的按换算后比，规格里写全的按规格比，有一边真正缺省无单位且给了明确三边的比数字 */
function sizeMatches(
  dims: LineFacts['dims'],
  p: Product,
  unitState: { known: boolean; lineUnknown: boolean; productUnknown: boolean },
  notes: Notes,
) {
  const { known, lineUnknown, productUnknown } = unitState;
  const values = normalizedDimensions(p);
  let sameDimensions = dims.unit && known ? unitDimensionsMatch(dims, values, notes) : false;
  if (dims.fromTuple && known) {
    if (dims.fromTuple.every((v, i) => v === values[i])) {
      sameDimensions = true;
      notes.reasons.push('规格尺寸一致（单位明确）');
    } else notes.conflicts.push('规格尺寸不一致');
  }
  if (sameDimensions) {
    notes.reasons.push('尺寸一致');
    return true;
  }
  // 任一边写了无法识别或互相矛盾的单位（如 in / 英寸，或规格与结构化单位不一致），绝不当缺省无单位去纯数字比对
  if (lineUnknown || productUnknown || dims.specUnitUnknown || dims.specUnitConflict || ((dims.unit || dims.tupleUnit) && known))
    return false;
  const raw = [p.length, p.width, p.height];
  // 缺单位时只凭数字一致列为候选，不自动推荐（缺单位不得猜测是 mm 还是 cm）
  const sameDigits = dims.explicit.every(
    (v, i) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v === raw[i],
  );
  if (sameDigits) {
    notes.reasons.push('尺寸数字一致（有一边没写单位）');
    return false;
  }
  // 仅规格原文里有三个数字、没拆分长宽高也没写单位：只作为候选提示，不凭它自动推荐
  if (
    dims.explicit.every((v) => v === null) &&
    dims.rawTuple &&
    dims.rawTuple.every((v, i) => v > 0 && v === raw[i])
  )
    notes.reasons.push('规格数字一致（未写单位，需确认）');
  return false;
}
/** 尺寸写法本身的问题：数值无效、任一边写了认不出或矛盾的单位、有一边没写单位（同名时提醒没换算） */
function dimensionWarnings({ f, dims }: LineFacts, p: Product, known: boolean) {
  const conflicts: string[] = [];
  const lineUnknown = Boolean(f.dimensionUnit.value?.trim() && !dims.unit);
  const productUnitText = (p.dimensionUnit ?? p.dimensionUnitRaw ?? '').trim();
  const productUnknown = Boolean(productUnitText && !known);
  if (dims.explicit.some((v) => v !== null && !Number.isFinite(v))) conflicts.push('尺寸数值无效');
  if (lineUnknown) conflicts.push('尺寸单位待确认');
  if (dims.specUnitUnknown) conflicts.push('规格尺寸单位待确认');
  if (dims.specUnitConflict) conflicts.push('规格与尺寸单位不一致');
  if (productUnknown) conflicts.push('档案尺寸单位待确认');
  const unitPending =
    (!dims.unit && dims.explicit.some((v) => v !== null)) ||
    (!known && !productUnknown && normalizedDimensions(p).some((v) => v !== null));
  return { conflicts, unitPending, lineUnknown, productUnknown };
}
function attributeNotes(f: Line['fields'], p: Product, notes: Notes) {
  for (const [field, label] of comparedAttributes) {
    const raw = f[field].value || '',
      value = field === 'productCode' ? p.customerProductCode : p[field];
    if (!raw || !value) continue;
    if (importNameKey(raw) !== importNameKey(value)) notes.conflicts.push(label + '不一致');
    else notes.reasons.push(label + '一致');
  }
  // 加工要求每份订单写法都不一样，不影响是不是同一个产品
  if (f.requirements.value && p.requirements && importNameKey(f.requirements.value) !== importNameKey(p.requirements))
    notes.reasons.push('加工要求和档案写法不同，不影响对应');
}
/** 一个产品档案能不能作这一行的候选，能的话列出理由、冲突、缺什么 */
function candidateFor(facts: LineFacts, p: Product): ProductCandidate | null {
  const known = !!normalizeDimensionUnit(p.dimensionUnit),
    id = identityMatch(facts, p),
    warn = dimensionWarnings(facts, p, known);
  const notes: Notes = { reasons: [], conflicts: warn.conflicts };
  if (id.sameName) notes.reasons.push('名称一致');
  if (id.sameCode) notes.reasons.push('客户料号一致（需核对客户归属）');
  const sameSize = sizeMatches(
    facts.dims,
    p,
    { known, lineUnknown: warn.lineUnknown, productUnknown: warn.productUnknown },
    notes,
  );
  if (id.contained) notes.reasons.push('名称包含档案名称');
  if (id.close && sameSize) notes.reasons.push('名称很像，请核对是否错别字');
  if (warn.unitPending && id.sameName) notes.reasons.push('尺寸单位待确认，未自动换算');
  attributeNotes(facts.f, p, notes);
  const hasUnitlessDigits =
    notes.reasons.includes('规格数字一致（未写单位，需确认）') ||
    notes.reasons.includes('尺寸数字一致（有一边没写单位）');
  if (!id.sameName && !id.sameCode && !sameSize && !hasUnitlessDigits && !id.contained) return null;
  // 名称包含要确认：“纸箱1”和“纸箱10”、“纸箱”和“纸箱加厚”是不同的货。只差括号里的说明（比如渠道名）才算同一个。
  const sameProduct =
    id.sameName ||
    (id.contained && bareName(facts.name) === bareName(id.pName) && sameNumbers(facts.name, id.pName));
  return {
    id: p.id,
    name: p.name,
    reasons: notes.reasons,
    conflicts: notes.conflicts,
    recommended: sameProduct && sameSize && !notes.conflicts.length,
    missing: requiredAttributes.filter(([k]) => !p[k]?.trim()).map(([, v]) => v),
  };
}
const byRank = (a: ProductCandidate, b: ProductCandidate) =>
  Number(b.recommended) - Number(a.recommended) ||
  a.conflicts.length - b.conflicts.length ||
  b.reasons.length - a.reasons.length ||
  a.id - b.id;
export function productCandidatesForLine(
  line: Line,
  products: Product[],
  customerId?: number | null,
): ProductCandidate[] {
  const facts: LineFacts = {
    f: line.fields,
    dims: lineDimensions(line),
    name: importNameKey(line.fields.productName.value || ''),
  };
  const scoped = customerId === undefined ? products : productsForCustomer(products, customerId);
  return (
    scoped
      .map((p) => candidateFor(facts, p))
      .filter((p) => p !== null)
      // 有完全同名的就只认它，名称包含的退回候选
      .map((p, _i, all) =>
        p.recommended &&
        !p.reasons.includes('名称一致') &&
        all.some((o) => o.recommended && o.reasons.includes('名称一致'))
          ? { ...p, recommended: false }
          : p,
      )
      .sort(byRank)
  );
}

export function emptyImportMapping(draft: OrderDraft): ImportMapping {
  return {
    customer: { mode: 'pending' },
    products: Object.fromEntries(draft.lines.map((l) => [l.id, { mode: 'pending' }])),
    roundingPolicy: 'exact-cents',
  };
}
export function productMatchKey(line: Line) {
  const f = line.fields,
    dims = lineDimensions(line);
  return JSON.stringify([
    importNameKey(f.productName.value || ''),
    specKey(f.specification.value || ''),
    dims.explicit.some((v) => v !== null && !Number.isFinite(v))
      ? dimensionKeys.map((k) => f[k].value)
      : dims.unit
        ? [...dims.values, dims.explicit.every((v) => v === null) ? dims.unit : 'known']
        : [...dims.explicit, importNameKey(f.dimensionUnit.value || '')],
    ...(['productCode', 'material', 'flute', 'requirements'] as const).map((k) =>
      importNameKey(f[k].value || ''),
    ),
  ]);
}
/** Used both by ImportManager and the unsaved manual editor; unrelated fields keep associations. */
export function invalidateImportMapping(
  mapping: ImportMapping | undefined,
  before: OrderDraft,
  after: OrderDraft,
  previous: MappingInvalidations = { products: {} },
) {
  if (!mapping) return { mapping, invalidated: previous };
  const next = structuredClone(mapping),
    invalidated = structuredClone(previous);
  if (
    importNameKey(before.header.buyerName.value || '') !==
      importNameKey(after.header.buyerName.value || '') &&
    next.customer.mode !== 'pending'
  ) {
    next.customer = { mode: 'pending' };
    invalidated.customer = '原客户选择已失效，请重新选择';
  }
  for (const line of after.lines) {
    const old = before.lines.find((l) => l.id === line.id);
    if (
      old &&
      productMatchKey(old) !== productMatchKey(line) &&
      next.products[line.id]?.mode &&
      next.products[line.id].mode !== 'pending'
    ) {
      next.products[line.id] = { mode: 'pending' };
      invalidated.products[line.id] = '原产品选择已失效，请重新选择';
    }
  }
  for (const id of Object.keys(next.products))
    if (!after.lines.some((l) => l.id === id)) {
      delete next.products[id];
      delete invalidated.products[id];
    }
  return { mapping: next, invalidated };
}
export const productCandidateDetails = (p: Product) =>
  [
    p.name,
    formatDimensions(p),
    p.customerProductCode && '料号 ' + p.customerProductCode,
    p.material && '材质 ' + p.material,
    p.flute && '楞型 ' + p.flute,
    p.requirements,
  ]
    .filter(Boolean)
    .join(' · ');

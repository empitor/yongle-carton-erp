import { createContext, useContext } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { dataManagementFieldName } from '../../shared/business/index';
import { blankCustomerSite, FINISHED_UNIT, MAX_TAX_PERCENT, RAW_UNIT, TAX_PERCENT_STEP, type ApiJson } from '../../shared/core/index';
import { FormField } from '../ui/index';
import RefField from './RefField';
import { withField } from './field-update';
import type { RecordRefs } from './record-refs';
import {
  isJsonList,
  isJsonObject,
  type JsonObject,
  type ManagedRecord,
} from './record-types';
import {
  allowsBlank,
  centsTwins,
  fieldChoices,
  hiddenFields,
  lockedReason,
  longText,
  numberFields,
  refKind,
  timeFields,
  unitNote,
  wideRef,
  yuanFields,
  type FieldContext,
} from './field-rules';

/** 编辑窗的上下文：在改哪一类记录、改的是哪一条、关联字段的候选、没法提交的那几格（见 field-rules.ts 的 FieldContext） */
const EditorContext = createContext<FieldContext>({
  module: '',
  record: null,
  refs: null,
  errors: {},
});
/** 这一层在编辑窗里的位置：上一层的字段名（最外层是空）、在改哪一类记录 */
type Where = { path: string; module: string };

/**
 * 数据管理里的通用字段编辑：普通字段三列排开，长文字占满一行；
 * 嵌套的对象和明细数组各占一行，明细每项一张卡片。最外层传 record、refs，里面各层从上下文拿。
 */
export default function DataManagementFields({
  value,
  change,
  module = '',
  record,
  refs,
  errors,
}: {
  value: JsonObject;
  change: (v: JsonObject) => void;
  /** 在编辑哪一类记录（orders、purchases、arrival…）：决定状态下拉列哪些、怎么叫 */
  module?: string;
  /** 正在编辑的那条（列表给的 record）；新建时是 null */
  record: ManagedRecord | null;
  /** 关联字段的候选；还在读是 null */
  refs: RecordRefs | null;
  /** 没法提交的那几格：字段路径 → 原因 */
  errors?: Record<string, string>;
}) {
  return (
    <EditorContext.Provider value={{ module, record, refs, errors: errors ?? {} }}>
      <FieldGroup value={value} change={change} path="" module={module} />
    </EditorContext.Provider>
  );
}

/** 一个值：明细数组每项一张卡片，对象按字段排开，别的是一个输入框 */
function FieldValue({ value, change, path, module }: Where & { value: ApiJson | undefined; change: (v: ApiJson) => void }) {
  if (isJsonList(value)) return <FieldList value={value} change={change} path={path} module={module} />;
  if (isJsonObject(value)) return <FieldGroup value={value} change={change} path={path} module={module} />;
  return (
    <input
      aria-label={path ? dataManagementFieldName(path) : '未填写'}
      value={value == null ? '' : String(value)}
      placeholder="未填写"
      onChange={(e) => change(e.currentTarget.value === '' ? null : e.currentTarget.value)}
    />
  );
}

/** 明细数组：每项一张卡片（可移除），最后一个“增加明细”；编号清单（生产任务的关联订单）每项一个选择器 */
function FieldList({ value, change, path, module }: Where & { value: readonly ApiJson[]; change: (v: ApiJson) => void }) {
  const outer = useContext(EditorContext);
  const primitive = path !== 'sites' && !value.some((x) => x && typeof x === 'object');
  const replace = (i: number, next: ApiJson) => change(value.map((x, j) => (j === i ? next : x)));
  // 明细照第一项的样子加一项（不带它的编号）；编号清单（生产任务的关联订单）加一项留空让人选，不拿 0 冒充编号
  const add = () => {
    const first = value[0];
    const item = path === 'sites' ? blankCustomerSite() : isJsonObject(first) ? { ...structuredClone(first), id: undefined } : null;
    change([...value, item]);
  };
  return (
    <div className="adm-data-array">
      {value.map((item, i) => (
        <section key={i} className="line-card">
          <header>
            <strong>第{i + 1}项</strong>
            <button type="button" className="danger" onClick={() => change(value.filter((_, j) => i !== j))}>
              <Trash2 size={14} aria-hidden="true" />
              移除本项
            </button>
          </header>
          {primitive && refKind(path) ? (
            <RefField
              ctx={outer}
              field={path}
              title={dataManagementFieldName(path) + ' 第' + (i + 1) + '项'}
              value={item}
              update={(v) => replace(i, v)}
            />
          ) : (
            <FieldValue value={item} path={path} module={module} change={(v) => replace(i, v)} />
          )}
        </section>
      ))}
      <button type="button" className="secondary adm-data-add" onClick={add}>
        <Plus size={14} aria-hidden="true" />
        {primitive ? '再加一项' : '增加明细'}
      </button>
    </div>
  );
}

/** 一层对象：普通字段三列排开；原材料不关联产品，没关联的不摆一个空选择器 */
function FieldGroup({ value, change, path, module }: Where & { value: JsonObject; change: (v: JsonObject) => void }) {
  const outer = useContext(EditorContext);
  const ctx = { ...outer, module: module || outer.module };
  return (
    <div className="ed-grid cols-3">
      {Object.entries(value)
        .filter(([k]) => !hiddenFields.has(k) && !centsTwins.has(k))
        .filter(
          ([k, v]) => !(ctx.module === 'stock_items' && !path && k === 'productId' && value.kind !== 'finished' && v == null),
        )
        .map(([key, v]) => (
          <FieldCell key={key} field={key} v={v} value={value} change={change} path={path} module={module} />
        ))}
    </div>
  );
}

type CellProps = Where & {
  /** 这一格的字段名和值 */
  field: string;
  v: ApiJson | undefined;
  /** 这一格所在的那层内容，和改这一层的函数 */
  value: JsonObject;
  change: (v: JsonObject) => void;
};

/** 一格：嵌套的对象和明细占一行、真假是勾选框、关联字段是选择器、数量单位只显示，别的是输入框或下拉 */
function FieldCell({ field: key, v, value, change, path, module }: CellProps) {
  const outer = useContext(EditorContext);
  const ctx = { ...outer, module: module || outer.module };
  const title = dataManagementFieldName(key, path, ctx.module),
    update = (x: ApiJson) => change(withField(value, key, x, module));
  if (isJsonObject(v) || isJsonList(v))
    return (
      <div className="form-field span-full adm-data-group" role="group" aria-label={title}>
        <span className="form-field-label">{title}</span>
        <FieldValue value={v} change={update} path={key} module={module} />
      </div>
    );
  if (typeof v === 'boolean')
    return (
      <label className="adm-data-check">
        <input type="checkbox" checked={v} onChange={(e) => update(e.currentTarget.checked)} />
        {title}
      </label>
    );
  const locked = lockedReason(key, value, path, ctx);
  if (refKind(key))
    return (
      // 可搜索选择器占两格：下拉跟着框一样宽，名称和后面的小字放得下，不从名称中间折行
      <FormField label={title} hint={locked || undefined} span={wideRef(key) ? 2 : 1}>
        <RefField ctx={outer} field={key} title={title} value={v} line={value} update={update} disabled={!!locked} />
      </FormField>
    );
  if (key === 'unit')
    return (
      <FormField label={title} hint={unitNote(ctx.module, path)}>
        <input aria-label={'数据管理 ' + title} disabled value={String(v ?? '')} />
      </FormField>
    );
  return (
    <PlainField field={key} v={v} value={value} change={change} path={path} module={module} title={title} locked={locked} />
  );
}

/** 输入框的种类：数字、日期、时间、文字 */
const inputType = (key: string, numeric: boolean) =>
  numeric ? 'number' : /Date$/.test(key) || key === 'date' ? 'date' : timeFields.has(key) ? 'time' : 'text';
/** 输入框没填时的提示：金额写“元”（参考单价写“没定价就空着”），存的是空写“未填写” */
const placeholderOf = (key: string, v: ApiJson | undefined, money: boolean) =>
  money ? (key === 'priceExact' ? '没定价就空着' : '元') : v === null ? '未填写' : '';
/** 这一格怎么填：长文字占满一行，金额按元填，数字用数字框 */
function inputKind(key: string, v: ApiJson | undefined, path: string, editing: string) {
  const money = yuanFields.has(key) || (path === 'costs' && key !== 'basis');
  const taxRate = editing === 'orders' && key === 'taxRate';
  // 订单数量和税率在新建模板里留空（null）时也用数字框。
  const numeric =
    !money && (numberFields.has(key) || typeof v === 'number' || taxRate || (editing === 'orders' && key === 'quantity'));
  return { long: longText.includes(key), money, numeric, taxRate };
}

/** 普通的一格：有选项的是下拉，长文字是多行框，别的是输入框；没法提交的原因写在格子下面 */
function PlainField({
  field: key,
  v,
  value,
  change,
  path,
  module,
  title,
  locked,
}: CellProps & { title: string; locked: string | null }) {
  const ctx = useContext(EditorContext),
    editing = module || ctx.module,
    update = (x: ApiJson) => change({ ...value, [key]: x });
  // 这一格没法提交的原因（嵌套对象按“上一层.字段”记，明细数组里的不分行，不在这里标）
  const invalid = ctx.errors?.[path ? path + '.' + key : key];
  const { long, money, numeric, taxRate } = inputKind(key, v, path, editing),
    choices = fieldChoices(key, v, module);
  // 库存品改种类：数量单位跟着种类走，改成原材料时清掉关联的产品（原材料不关联产品）
  const choose = (x: string | null) =>
    editing === 'stock_items' && !path && key === 'kind'
      ? change({
          ...value,
          kind: x,
          unit: x === 'finished' ? FINISHED_UNIT : RAW_UNIT,
          ...(x === 'raw' ? { productId: null } : {}),
        })
      : update(x);
  return (
    <FormField label={title} span={long ? 'full' : 1} hint={locked || undefined} error={invalid}>
      {choices ? (
        <select
          aria-label={'数据管理 ' + title}
          aria-invalid={invalid ? true : undefined}
          disabled={!!locked}
          value={String(v ?? '')}
          onChange={(e) => choose(e.currentTarget.value || null)}
        >
          {allowsBlank(key, v) && <option value="">未填写</option>}
          {choices.map(([code, text]) => (
            <option key={code} value={code}>
              {text}
            </option>
          ))}
        </select>
      ) : long ? (
        <textarea
          aria-label={'数据管理 ' + title}
          aria-invalid={invalid ? true : undefined}
          disabled={!!locked}
          value={String(v ?? '')}
          onChange={(e) => update(e.currentTarget.value)}
        />
      ) : (
        <input
          aria-label={'数据管理 ' + title}
          aria-invalid={invalid ? true : undefined}
          disabled={!!locked}
          type={inputType(key, numeric)}
          inputMode={money ? 'decimal' : undefined}
          min={taxRate ? 0 : undefined}
          max={taxRate ? MAX_TAX_PERCENT : undefined}
          step={taxRate ? TAX_PERCENT_STEP : numeric ? 'any' : undefined}
          value={v == null ? '' : String(v)}
          placeholder={placeholderOf(key, v, money)}
          onChange={(e) => {
            const text = e.currentTarget.value;
            update(text === '' ? (money ? '' : null) : numeric ? Number(text) : text);
          }}
        />
      )}
    </FormField>
  );
}

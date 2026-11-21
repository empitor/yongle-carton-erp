import type { ReactNode } from 'react';
import { EmptyState, TableRegion } from './ListLayout';
import { yuan } from './money';

/*
 * 列表表格：列定义、勾选列、点行开详情。财务、单据、到货送货、流水、收件箱、账号这些列表都用它；
 * 行上“点一下或按回车打开详情”和勾选框只在这里写（tests/ui-kit.test.ts 守着）。
 * 手机上表格变卡片由 src/mobile/MobileNav.tsx 的 useMobileTables 统一处理：列名取表头，勾选列不显示。
 */

/** 列没写行类型（`Col[]`）时的行：按列名取值。放进有类型的表格照样能用（行类型从 rows 推）。 */
type AnyRow = { readonly [key: string]: unknown };
/** 行的键：React 的 key、开着详情的那一行、勾选都按它认 */
export type RowKey = string | number;

export type Col<R = AnyRow> = {
  key: string;
  label: ReactNode;
  /** 分转元，右对齐 */
  money?: boolean;
  num?: boolean;
  /** 长文字列：放不下省略 */
  wrap?: boolean;
  /** 单号列：加粗、数字等宽 */
  rowNo?: boolean;
  /**
   * 列优先级（src/ui/list-layout-5.css“列表的列优先级”）：表格区域窄于 900px 时收起 low，窄于 660px 时再收起 mid。
   * 关键列不标，一直显示；手机卡片不收列。
   */
  priority?: 'low' | 'mid';
  /** 表头和格子都带的类名 */
  className?: string;
  /** 只给格子的类名，可以按行定（正负数的颜色） */
  cellClass?: string | ((row: R) => string);
  /** 格子的悬停提示（放不下省略的长文字） */
  title?: (row: R) => string;
  render?: (row: R) => ReactNode;
};

export const col = <R = AnyRow,>(key: string, label: ReactNode, extra: Partial<Col<R>> = {}): Col<R> => ({
  key,
  label,
  ...extra,
});
export const mon = <R = AnyRow,>(key: string, label: string): Col<R> => ({ key, label, money: true });

/** 拼类名（没有就不写 class） */
const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ') || undefined;
/** 列按行定的格子类名 */
const ownCellClass = <R,>(c: Col<R>, row: R) => (typeof c.cellClass === 'function' ? c.cellClass(row) : c.cellClass);

const cellText = (v: unknown): ReactNode => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
};

/** 一个格子：写了 render 的照它画，金额列分转元，其余按列名取值 */
function cell<R extends object>(c: Col<R>, row: R): ReactNode {
  if (c.render) return c.render(row);
  const value: unknown = Reflect.get(row, c.key);
  return c.money ? yuan(value) : cellText(value);
}

/** 没给键时按行的 id 认；没有 id 的行没有键 */
const rowId = (row: object): RowKey | null | undefined => {
  if (!('id' in row)) return undefined;
  const id = row.id;
  return typeof id === 'string' || typeof id === 'number' || id === null ? id : undefined;
};

/** 点在行里的链接、按钮、输入框上不算点这一行（它们自己处理） */
const onControl = (target: EventTarget) =>
  target instanceof Element && target.closest('a,button,input,select,label') !== null;

/**
 * 列表的一行：给了 open 就能点开详情（点行或在行上按回车），开着的那一行标出来。
 * DataTable 用它画行；表头和格子按记录种类另写的业务列表（src/records/RecordTable.tsx）也直接用它。
 */
export function DataRow({
  open,
  opened = false,
  children,
}: {
  open?: () => void;
  /** 右侧详情开着的就是这一行 */
  opened?: boolean;
  children: ReactNode;
}) {
  if (!open) return <tr>{children}</tr>;
  return (
    <tr
      tabIndex={0}
      className={'record-row' + (opened ? ' selected' : '')}
      aria-selected={opened}
      onClick={(e) => {
        if (!onControl(e.target)) open();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) open();
      }}
    >
      {children}
    </tr>
  );
}

/** 表头的全选框：勾上选中 keys 全部，去掉清空 */
export function SelectAll<K extends RowKey>({
  keys,
  selected,
  set,
  label,
}: {
  keys: readonly K[];
  selected: readonly K[];
  set: (next: K[]) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      title={label}
      checked={keys.length > 0 && keys.every((k) => selected.includes(k))}
      onChange={(e) => set(e.currentTarget.checked ? [...keys] : [])}
    />
  );
}

/** 一行的勾选框 */
export function SelectRow<K extends RowKey>({
  value,
  selected,
  set,
  label,
}: {
  value: K;
  selected: readonly K[];
  set: (next: K[]) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={selected.includes(value)}
      onChange={(e) => set(e.currentTarget.checked ? [...selected, value] : selected.filter((x) => x !== value))}
    />
  );
}

/** 勾选列：每行按什么认、勾了哪些、全选勾哪些行、读屏念的名字 */
type Check<R, K extends RowKey> = {
  key: (row: R) => K;
  selected: readonly K[];
  set: (next: K[]) => void;
  /** 全选勾的行（筛选结果全部，或服务端分页时的这一页） */
  all: readonly R[];
  allLabel: string;
  rowLabel: (row: R) => string;
};

type DataTableProps<R, K extends RowKey> = {
  cols: readonly Col<R>[];
  rows: readonly R[];
  /** 表格区域的名字（读屏念“…，可左右滚动”） */
  label: string;
  /** 表格自己的类名（各列表的列宽、手机卡片的写法） */
  className?: string;
  /** 行的键，不给时按勾选的键，再没有按行的 id */
  rowKey?: (row: R, index: number) => RowKey;
  /** 点行打开详情 */
  onRow?: (row: R) => void;
  /** 开着详情的那一行的键 */
  selected?: RowKey | null;
  /** 空着时表格里那一行的标题（不给说“这里还没有记录”）；null 不画这一行，页面自己在表格外说 */
  empty?: string | null;
  emptyNote?: string;
  check?: Check<R, K>;
};

export function DataTable<R extends object, K extends RowKey = RowKey>(props: DataTableProps<R, K>) {
  const { cols, rows, label, className, rowKey, onRow, selected, empty, emptyNote = '', check } = props;
  return (
    <TableRegion label={label}>
      <table className={className}>
        <thead>
          <tr>
            {check && (
              <th>
                <SelectAll
                  keys={check.all.map(check.key)}
                  selected={check.selected}
                  set={check.set}
                  label={check.allLabel}
                />
              </th>
            )}
            {cols.map((c) => (
              <th key={c.key} className={classes((c.money || c.num) && 'num', c.priority && 'col-' + c.priority, c.className)}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const k = rowKey ? rowKey(row, i) : check ? check.key(row) : rowId(row);
            return (
              <DataRow key={k} open={onRow && (() => onRow(row))} opened={k !== undefined && selected === k}>
                {check && (
                  <td>
                    <SelectRow
                      value={check.key(row)}
                      selected={check.selected}
                      set={check.set}
                      label={check.rowLabel(row)}
                    />
                  </td>
                )}
                {cols.map((c) => (
                  <td
                    key={c.key}
                    className={classes(
                      c.money || c.num ? 'num' : c.wrap && 'cell-wrap',
                      c.rowNo && 'record-no',
                      c.priority && 'col-' + c.priority,
                      c.className,
                      ownCellClass(c, row),
                    )}
                    title={c.title?.(row)}
                  >
                    {cell(c, row)}
                  </td>
                ))}
              </DataRow>
            );
          })}
          {!rows.length && empty !== null && (
            <tr>
              <td colSpan={cols.length + (check ? 1 : 0)}>
                <EmptyState title={empty || '这里还没有记录'} description={emptyNote} />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </TableRegion>
  );
}

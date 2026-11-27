import type { ReactNode } from 'react';

/** 块里的一行：字段名和内容；className 给调用方挂这一行自己的写法（如备注全文换行） */
export type InfoBlockRow = { label: string; value: ReactNode; className?: string };

const withExtra = (base: string, extra?: string) => (extra ? base + ' ' + extra : base);

/**
 * 详情里一节多条同类、字段又多的记录（成品库存的批次、客户的厂区）：一条一块浅底圆角块上下排，
 * 不用多列表格（docs/界面/总规矩.md“详情”）。样式在 kit.css 的 kit-blocks、kit-block；
 * 块的头部和变体（底色、边框）由调用方经 header、className 给，样式写在调用方自己的目录。
 */
export function InfoBlocks({ className, children }: { className?: string; children: ReactNode }) {
  return <ul className={withExtra('kit-blocks', className)}>{children}</ul>;
}

/** 一块：调用方给的头部，下面只列给了的几行（字段名一列，和详情里别的节的字段名对齐） */
export function InfoBlock({ className, header, rows }: {
  className?: string;
  header: ReactNode;
  rows: readonly InfoBlockRow[];
}) {
  return (
    <li className={withExtra('kit-block', className)}>
      {header}
      {rows.length > 0 && (
        <dl>
          {rows.map((r) => (
            <div key={r.label} className={r.className}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

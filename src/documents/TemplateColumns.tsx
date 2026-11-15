import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-react';
import { documentColumns, optionalDocumentFields, templateColumnsAreDefault, type DocumentColumn, type DocumentTemplate } from '../../shared/documents/index';
import { FormGroup, FormSection } from '../ui/index';

const fixed = ['name', 'unit', 'quantity'];
/** 明细里能印的全部列（照 documentColumns 的先后） */
const allColumns = Object.keys(documentColumns).filter((key): key is DocumentColumn => key in documentColumns);

/** 单据模板的“明细里印哪些列”：已显示的列可排序、可去掉；没显示的列点一下加进来。 */
export default function TemplateColumns({
  kind,
  template,
  columns,
  edit,
  resetColumns,
}: {
  kind: 'purchase' | 'delivery';
  template: DocumentTemplate;
  columns: DocumentColumn[];
  edit: (patch: Partial<DocumentTemplate>) => void;
  resetColumns: () => void;
}) {
  const move = (i: number, offset: number) => {
    const order = [...columns];
    [order[i], order[i + offset]] = [order[i + offset], order[i]];
    edit({ columns: order });
  };
  const hidden = allColumns.filter((key) => !columns.includes(key));
  return (
    <FormSection
      title="明细字段与顺序"
      hint="产品名称、数量和数量单位始终保留，尺寸单位保持原记录。"
      columns={1}
      extra={
        <button
          type="button"
          className="secondary"
          disabled={templateColumnsAreDefault(template)}
          title={
            templateColumnsAreDefault(template)
              ? '已经是默认的明细字段和顺序'
              : '明细字段和顺序改回默认，其他设置不变；保存后生效'
          }
          onClick={resetColumns}
        >
          <RotateCcw size={14} aria-hidden="true" />
          恢复默认
        </button>
      }
    >
      <FormGroup label="已显示（按顺序）">
        <ol className="adm-col-list">
          {columns.map((key, i) => (
            <li key={key}>
              <span className="adm-col-order">{i + 1}</span>
              <label>
                <input
                  type="checkbox"
                  checked
                  disabled={fixed.includes(key)}
                  onChange={() => edit({ columns: columns.filter((c) => c !== key) })}
                />
                {documentColumns[key]}
                {fixed.includes(key) && <small>必印</small>}
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label={'上移' + documentColumns[key]}
                disabled={!i}
                onClick={() => move(i, -1)}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={'下移' + documentColumns[key]}
                disabled={i === columns.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown size={14} />
              </button>
            </li>
          ))}
        </ol>
      </FormGroup>
      <FormGroup
        label="可加入的列"
        hint={
          kind === 'delivery'
            ? '送货单默认不显示价格。价格列只用送货快照，历史批次没有快照时显示“未记录”。'
            : undefined
        }
      >
        {hidden.length ? (
          <div className="adm-chip-list">
            {hidden.map((key) => (
              <label key={key} className="adm-chip">
                <input
                  type="checkbox"
                  checked={false}
                  onChange={() => edit({ columns: [...columns, key] })}
                />
                {documentColumns[key]}
              </label>
            ))}
          </div>
        ) : (
          <p className="choice-list-empty">所有列都已显示。</p>
        )}
      </FormGroup>
      <details className="line-card-more adm-template-more">
        <summary>其他信息的显示与隐藏</summary>
        <div className="adm-chip-list">
          {optionalDocumentFields.map((k) => (
            <label key={k} className="adm-chip">
              <input
                type="checkbox"
                checked={!template.hiddenFields.includes(k)}
                onChange={(e) =>
                  edit({
                    hiddenFields: e.target.checked
                      ? template.hiddenFields.filter((f) => f !== k)
                      : [...template.hiddenFields, k],
                  })
                }
              />
              {k}
            </label>
          ))}
        </div>
      </details>
    </FormSection>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Save } from 'lucide-react';
import { ManagementDialog } from '../ui/index';
import { dataManagementNames } from '../../shared/business/index';
import { EditorFooter, FormMessage } from '../ui/index';
import DataManagementFields from './DataManagementFields';
import type { RecordRefs } from './record-refs';
import { textOf, type BusinessRecord, type JsonObject } from './record-types';

/**
 * 数据管理里编辑或新建一条记录：单独一个窗口，保存后关掉回到列表。
 * 保存没成：哪一格填得不对写在那一格下面，光标放过去；服务端退回的原因写在窗口顶上，滚到能看见的地方
 * （窗口长，点底部的保存时顶上不在视野里）。
 */
export default function DataManagementRecordDialog({
  module,
  editing,
  input,
  setInput,
  busy,
  error,
  sameName = false,
  fieldErrors = {},
  refs,
  save,
  close,
}: {
  module: string;
  /** 在改的那条（列表给的）；新建时是 null */
  editing: BusinessRecord | null;
  /** 编辑窗里的内容 */
  input: JsonObject;
  setInput: (v: JsonObject) => void;
  busy: boolean;
  error: string;
  /** 服务端提示同客户已有同名不同规格产品，需人确认“是另一个产品” */
  sameName?: boolean;
  /** 没法提交的那几格（按字段路径，如“costs.material”）：原因写在那一格下面 */
  fieldErrors?: Record<string, string>;
  /** 关联字段的候选（客户、产品、订单……），还在读是 null */
  refs: RecordRefs | null;
  save: () => void;
  close: () => void;
}) {
  // 每点一次保存加一：同一句报错再出现一次也要再滚过去
  const [attempt, setAttempt] = useState(0);
  const messageRef = useRef<HTMLDivElement>(null),
    formRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) {
      messageRef.current?.firstElementChild?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    const invalid = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (invalid) {
      invalid.scrollIntoView?.({ block: 'center' });
      invalid.focus({ preventScroll: true });
    }
    // 只在点保存、报错变了时滚；改着某一格时（标错的格子少了）不把光标抢走
  }, [attempt, error]);
  const record = editing?.record ?? null,
    party = textOf(record?.customerName) || textOf(record?.supplierName);
  return (
    <ManagementDialog
      title={
        record
          ? '编辑 ' + (textOf(record.number) || textOf(record.name) || dataManagementNames[module])
          : '新建' + dataManagementNames[module]
      }
      subtitle={dataManagementNames[module] + (party ? ' · ' + party : '')}
      size="lg"
      busy={busy}
      close={close}
      footer={
        <EditorFooter note="直接保存。关联和库存同步重算，历史和审计保留。">
          <button className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              setAttempt((n) => n + 1);
              save();
            }}
          >
            <Save size={14} aria-hidden="true" />
            {busy ? '正在保存…' : sameName ? '是另一个产品，保存' : '保存' + dataManagementNames[module]}
          </button>
        </EditorFooter>
      }
    >
      {/* display: contents 不多占版面，只给“滚到报错处”一个抓手 */}
      <div ref={messageRef} style={{ display: 'contents' }}>
        <FormMessage>{error}</FormMessage>
      </div>
      <div className="adm-data-form" ref={formRef}>
        <DataManagementFields
          value={input}
          change={setInput}
          module={module}
          record={record}
          refs={refs}
          errors={fieldErrors}
        />
      </div>
    </ManagementDialog>
  );
}

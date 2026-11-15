import { useState } from 'react';
import { EditorFooter, FormField, FormMessage, FormSection, ManagementDialog, useAction } from '../ui/index';
import { readFlow, saveDocumentInfo } from './flow-api';
import { correctLabel, infoChangedMessage, type CorrectableKind } from './flow-words';

/** 说明里的文字项：清空存空串 */
type TextKey = 'notes' | 'address' | 'contact' | 'phone' | 'operator';
/** 能改的说明：文字项和时间（时间清空存 null） */
type InfoKey = TextKey | 'actualTime';
/** 单据上这几项现在的值（这种单据没有的项当空） */
type InfoValues = Partial<Record<InfoKey, string | null>>;
/** 交给服务端的：只放改了的那几项 */
type InfoPatch = Partial<Record<TextKey, string>> & { actualTime?: string | null };

/** 每种单据“编辑”能改的说明字段：叫什么、怎么输入 */
type Field =
  | { key: TextKey; label: string; kind?: 'long'; placeholder?: string }
  | { key: 'actualTime'; label: string; kind: 'time'; placeholder?: undefined };
const fields: Record<CorrectableKind, Field[]> = {
  arrival: [
    { key: 'actualTime', label: '到货时间', kind: 'time' },
    { key: 'notes', label: '备注', kind: 'long' },
  ],
  delivery: [
    { key: 'address', label: '收货地址' },
    { key: 'contact', label: '收货联系人' },
    { key: 'phone', label: '联系方式' },
    { key: 'actualTime', label: '实际送货时间', kind: 'time' },
    { key: 'notes', label: '备注', kind: 'long' },
  ],
  production: [
    { key: 'operator', label: '机台操作' },
    // 完工单的备注就是成品库存里那一批的“批次备注”
    { key: 'notes', label: '批次备注', kind: 'long', placeholder: '这批用的什么料、质量怎样' },
  ],
};
const text = (v: unknown) => (v == null ? '' : String(v));

/**
 * 别人刚改过这张单、读回最新的以后窗口里的值：人改过的几项（和原来读到的 before 不一样）留着人填的，
 * 没动过的换成最新的（fresh）。
 */
export const mergeInfo = (keys: readonly InfoKey[], values: Record<string, string>, before: InfoValues, fresh: InfoValues) =>
  Object.fromEntries(
    keys.map((k) => [k, values[k].trim() !== text(before[k]).trim() ? values[k] : text(fresh[k])]),
  );

/** 只交改了的那几项：时间清空交 null，文字去掉首尾空白 */
function changedInfo(list: readonly Field[], values: Record<string, string>, base: InfoValues) {
  const patch: InfoPatch = {};
  for (const f of list) {
    if (values[f.key].trim() === text(base[f.key]).trim()) continue;
    if (f.kind === 'time') patch.actualTime = values[f.key] || null;
    else patch[f.key] = values[f.key].trim();
  }
  return patch;
}

/** 接口回答的状态码；不是接口出错时没有 */
const failureStatus = (e: unknown) => (e instanceof Error && 'status' in e ? e.status : undefined);

/**
 * 已生效的到货、送货、完工单的“编辑”：只改备注、时间、地址联系人、操作人这类说明，不动库存和金额，不出替代单。
 * 详情的“编辑”、数据管理的“编辑”、成品批次的“写备注 / 编辑备注”都打开这一个窗口；
 * 数量、领料、日期这些要改用“更正××单”。保存就关这个窗口，没保存成的原因显示在窗口里。
 * doc 要有 id、kind、number、version 和这几项现在的值。
 */
export default function DocumentInfoDialog({
  doc,
  close,
  saved,
}: {
  doc: InfoValues & { id: number; kind: CorrectableKind; number: string; version: number; date: string };
  close: () => void;
  saved: (result: { number: string; changed: boolean }) => void;
}) {
  const kind = doc.kind,
    list = fields[kind];
  // 比对和版本的基准：打开时的内容；保存时发现别人刚改过，换成读回的最新内容
  const [base, setBase] = useState<InfoValues & { id: number; version: number }>(doc),
    [notice, setNotice] = useState('');
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(list.map((f) => [f.key, text(doc[f.key])])),
  );
  const { busy, error, run } = useAction();
  const patch = changedInfo(list, values, base);
  const save = () =>
    run(async () => {
      setNotice('');
      try {
        saved(await saveDocumentInfo(base.id, { expectedVersion: base.version, ...patch }));
      } catch (e) {
        // 别人刚改过这张单（版本变了）：读回最新的，人改过的几项留着，说一句请人核对后再保存，不卡住
        if (failureStatus(e) !== 409) throw e;
        const fresh = await readFlow(base.id);
        if (fresh.version === base.version) throw e;
        setValues((v) => mergeInfo(list.map((f) => f.key), v, base, fresh));
        setBase(fresh);
        setNotice(infoChangedMessage);
      }
    });
  return (
    <ManagementDialog
      title={'编辑 · ' + doc.number}
      subtitle={doc.date}
      size="sm"
      close={close}
      busy={busy}
      footer={
        <EditorFooter note={'只改说明，库存和金额不变。数量要改请用“' + correctLabel(kind) + '”。'}>
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !Object.keys(patch).length}
            onClick={() => void save()}
          >
            保存
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error}</FormMessage>
      <FormMessage tone="warning">{notice}</FormMessage>
      <FormSection columns={1}>
        {list.map((f) => (
          <FormField key={f.key} label={f.label} span="full" hint={f.kind === 'time' ? '不知道就留空' : undefined}>
            {f.kind === 'long' ? (
              <textarea
                aria-label={f.label}
                placeholder={f.placeholder}
                value={values[f.key]}
                maxLength={2000}
                rows={4}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            ) : (
              <input
                aria-label={f.label}
                type={f.kind === 'time' ? 'time' : 'text'}
                value={values[f.key]}
                maxLength={f.kind === 'time' ? undefined : 2000}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            )}
          </FormField>
        ))}
      </FormSection>
    </ManagementDialog>
  );
}

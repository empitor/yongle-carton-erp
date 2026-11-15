import { Plus } from 'lucide-react';
import type { PromptPreset, PromptSettingsView } from '../../shared/ai/index';
import { MoreMenu } from '../ui/index';
import { FormField } from '../ui/index';

type Entry = PromptPreset['entries'][number];
type Props = {
  current: PromptPreset;
  setCurrent: (next: PromptPreset | ((now: PromptPreset | null) => PromptPreset | null)) => void;
  state: PromptSettingsView | null;
  /** 库里存的那一份（还没保存过是 undefined） */
  saved: PromptPreset | undefined;
  dirty: boolean;
  busy: boolean;
  editable: boolean;
  assistant: boolean;
  command: (action: 'copy' | 'delete' | 'restore', id: string) => void;
  save: (activate?: boolean) => void;
};
/** 一份预设最多几条、一条最多多少字 */
const MAX_ENTRIES = 40;
const ENTRY_MAX_CHARS = 16000;

/**
 * 一份提示词预设的编辑区：名称、条目（名称、启用、内容、顺序）、保存。
 * 只读时（不是超级管理员账号）编辑框只能看不能改，复制、恢复、删除、添加条目、保存这些按钮都不显示。
 */
export default function PromptEditor(props: Props) {
  const { current, setCurrent, saved, dirty, busy, editable, state } = props;
  function entry(index: number, patch: Partial<Entry>) {
    setCurrent((p) =>
      p
        ? {
            ...p,
            entries: p.entries.map((e, i) => (i === index ? { ...e, ...patch } : e)),
          }
        : p,
    );
  }
  function move(index: number, direction: number) {
    setCurrent((p) => {
      if (!p) return p;
      const entries = [...p.entries];
      [entries[index], entries[index + direction]] = [entries[index + direction], entries[index]];
      return { ...p, entries };
    });
  }
  const card = { busy, editable, count: current.entries.length, entry, move };
  return (
    <section className="adm-prompt-editor" aria-label="编辑提示词预设">
      <header>
        <FormField label="预设名称">
          <input
            aria-label="提示词预设名称"
            value={current.name}
            maxLength={80}
            disabled={busy}
            readOnly={!editable}
            onChange={(e) => setCurrent({ ...current, name: e.currentTarget.value })}
          />
        </FormField>
        <span className={'adm-prompt-state' + (dirty ? ' dirty' : '')}>
          {dirty ? '有未保存修改' : saved ? '已保存' : '还没保存'}
          {current.id === state?.activeId ? ' · 使用中' : ''}
        </span>
        {editable && <PresetMenu {...props} />}
      </header>
      <div className="adm-prompt-entries">
        {current.entries.map((e, i) => (
          <EntryCard
            key={e.id}
            {...card}
            e={e}
            i={i}
            remove={() => setCurrent({ ...current, entries: current.entries.filter((x) => x.id !== e.id) })}
          />
        ))}
      </div>
      {editable && (
        <button
          className="secondary adm-prompt-add"
          disabled={busy || current.entries.length >= MAX_ENTRIES}
          onClick={() =>
            setCurrent({
              ...current,
              entries: [
                ...current.entries,
                {
                  id: crypto.randomUUID(),
                  name: '规则条目 ' + (current.entries.length + 1),
                  content: '',
                  enabled: true,
                },
              ],
            })
          }
        >
          <Plus size={14} aria-hidden="true" />
          添加条目
        </button>
      )}
      <SaveFooter {...props} />
    </section>
  );
}

/** 预设的“更多”：复制为新预设、恢复默认条目、删除预设（只剩一份时不能删） */
function PresetMenu({ current, state, saved, dirty, busy, command }: Props) {
  return (
    <MoreMenu label="预设更多操作" text="更多">
      <button
        type="button"
        role="menuitem"
        disabled={busy || !saved || dirty}
        title={dirty ? '先保存修改再复制' : undefined}
        onClick={() => command('copy', current.id)}
      >
        复制为新预设
      </button>
      <button type="button" role="menuitem" disabled={busy || !saved} onClick={() => command('restore', current.id)}>
        恢复默认条目
      </button>
      <hr className="more-menu-sep" />
      <button
        type="button"
        role="menuitem"
        className="danger-text"
        disabled={busy || !saved || state?.presets.length === 1}
        onClick={() => command('delete', current.id)}
      >
        删除预设
      </button>
    </MoreMenu>
  );
}

/** 一个条目：名称、启用、“更多”（上移、下移、删除）、内容和字数 */
function EntryCard({
  e,
  i,
  count,
  busy,
  editable,
  entry,
  move,
  remove,
}: {
  e: Entry;
  i: number;
  /** 一共几条（最后一条不能下移） */
  count: number;
  busy: boolean;
  editable: boolean;
  entry: (index: number, patch: Partial<Entry>) => void;
  move: (index: number, direction: number) => void;
  remove: () => void;
}) {
  return (
    <article className={'line-card adm-prompt-entry' + (!e.enabled ? ' is-off' : '')}>
      <header>
        <span className="adm-prompt-order">{i + 1}</span>
        <input
          aria-label={'条目' + (i + 1) + '名称'}
          value={e.name}
          maxLength={80}
          disabled={busy}
          readOnly={!editable}
          onChange={(v) => entry(i, { name: v.currentTarget.value })}
        />
        <label className="adm-check">
          <input
            type="checkbox"
            aria-label={'启用条目' + (i + 1)}
            checked={e.enabled}
            disabled={busy || !editable}
            onChange={(v) => entry(i, { enabled: v.currentTarget.checked })}
          />
          启用
        </label>
        {editable && (
          <MoreMenu label={'条目' + (i + 1) + '更多操作'}>
            <button type="button" role="menuitem" disabled={busy || i === 0} onClick={() => move(i, -1)}>
              上移
            </button>
            <button type="button" role="menuitem" disabled={busy || i === count - 1} onClick={() => move(i, 1)}>
              下移
            </button>
            <hr className="more-menu-sep" />
            <button type="button" role="menuitem" className="danger-text" disabled={busy} onClick={remove}>
              删除条目
            </button>
          </MoreMenu>
        )}
      </header>
      <textarea
        aria-label={'条目' + (i + 1) + '内容'}
        rows={Math.min(14, Math.max(3, e.content.split('\n').length + Math.ceil(e.content.length / 60)))}
        maxLength={ENTRY_MAX_CHARS}
        value={e.content}
        disabled={busy}
        readOnly={!editable}
        placeholder={editable ? '例如：客户表格中的“品名”实际填写尺寸时，应结合上下文分别填写产品名称和规格型号。' : ''}
        onChange={(v) => entry(i, { content: v.currentTarget.value })}
      />
      <footer>
        <span>{e.enabled ? '按当前顺序发送' : '已停用，内容仍保留'}</span>
        <span>
          {e.content.length}/{ENTRY_MAX_CHARS} 字
        </span>
      </footer>
    </article>
  );
}

/** 底部：字数和说明，只保存不启用（收在“更多”）、保存并启用 */
function SaveFooter({ current, state, dirty, busy, editable, assistant, save }: Props) {
  return (
    <footer className="adm-prompt-save">
      <span>
        {current.entries.reduce((n, e) => n + e.content.length, 0)} / 24000 字，最多 {MAX_ENTRIES} 条。
        {assistant
          ? '启用后用于下一条助手消息。工具范围、账号权限和业务校验由程序控制，提示词改不了。'
          : '启用后用于下一次识别，已有的识别结果不变。输出格式、金额重算和人工核对由程序控制，提示词改不了。'}
      </span>
      {editable && (
        <>
          <MoreMenu label="保存的其他方式">
            <button
              type="button"
              role="menuitem"
              disabled={busy || !dirty || !current.name.trim()}
              onClick={() => save()}
            >
              只保存不启用
            </button>
          </MoreMenu>
          <button
            type="button"
            className="primary"
            disabled={busy || !current.name.trim() || (!dirty && current.id === state?.activeId)}
            onClick={() => save(true)}
          >
            {busy ? '正在保存…' : '保存并启用'}
          </button>
        </>
      )}
    </footer>
  );
}

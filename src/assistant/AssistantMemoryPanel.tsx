import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { MoreMenu, beijingTime, Loading } from '../ui/index';
import type { ConfirmFn } from './assistant-types';
import type { AssistantMemoryItem } from './assistant-api';
import { useAssistantMemory } from './useAssistantMemory';

/**
 * 助手窗口里的“记忆”面板（打开时代替聊天记录和输入区）：当前账号记了什么、什么时候记的；
 * 手动加一条、改、删、清空，开关自动记忆。和助手的 memory.* 工具能做的一样。
 */
export default function AssistantMemoryPanel({
  confirm,
  onClose,
}: {
  confirm: ConfirmFn;
  onClose: () => void;
}) {
  const memory = useAssistantMemory();
  const [draft, setDraft] = useState('');
  const view = memory.view;
  const chars = view?.limits.chars ?? 200;
  return (
    <section className="ga-memory" aria-label="记忆">
      <div className="ga-memory-head">
        <button type="button" className="ga-memory-back" onClick={onClose}>
          <ArrowLeft size={15} aria-hidden="true" />
          返回聊天
        </button>
        <strong>记忆</strong>
        {view && (
          <small>
            {view.memories.length} / {view.limits.count} 条
          </small>
        )}
        <MoreMenu label="记忆更多操作">
          <button
            type="button"
            role="menuitem"
            className="danger-text"
            disabled={!view?.memories.length || memory.busy}
            onClick={async () => {
              // 没读到记忆时按钮是灰的
              if (!view) return;
              if (
                await confirm({
                  title: '清空记忆',
                  message:
                    '删掉你的全部 ' +
                    view.memories.length +
                    ' 条记忆，删了找不回来。自动记忆的开关不变。',
                  confirmLabel: '清空记忆',
                  danger: true,
                })
              )
                void memory.clear();
            }}
          >
            清空全部记忆
          </button>
        </MoreMenu>
      </div>
      <div className="ga-memory-body">
        <label className="ga-memory-auto">
          <input
            type="checkbox"
            role="switch"
            checked={view?.autoSave ?? true}
            disabled={!view || memory.busy}
            onChange={(e) => void memory.setAutoSave(e.target.checked)}
          />
          <span>
            自动记忆
            <small>
              {view?.autoSave === false
                ? '已关掉：助手不再自己记，已有的照样用。'
                : '开着：你说“以后都……”这类偏好、说法和纠正时，助手会自己记下。'}
            </small>
          </span>
        </label>
        <p className="ga-memory-note">
          只有你自己能看到。记忆只是偏好和说法，不能改变确认、权限和规则；密码这类机密不会记。
        </p>
        <form
          className="ga-memory-add"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await memory.add(draft.trim())) setDraft('');
          }}
        >
          <textarea
            aria-label="手动加一条记忆"
            placeholder="手动加一条，比如：客户甲的报价以后都按含税算"
            rows={2}
            maxLength={chars}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="primary" disabled={!draft.trim() || memory.busy}>
            记住
          </button>
        </form>
        {memory.error && (
          <p className="ga-error" role="alert">
            {memory.error}
          </p>
        )}
        {!view ? (
          !memory.error && <Loading />
        ) : !view.memories.length ? (
          <p className="ga-empty">
            还没有记忆。你说出以后都适用的偏好时，助手会自己记下；也可以在上面手动加。
          </p>
        ) : (
          <ul className="ga-memory-list">
            {view.memories.map((m) => (
              <MemoryRow
                key={m.id}
                item={m}
                chars={chars}
                busy={memory.busy}
                onSave={(content) => memory.update(m.id, content)}
                onRemove={() => void memory.remove(m.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** 一条记忆：平时显示内容、什么时候记的、谁记的；点“改”就地改，改完保存或取消。 */
function MemoryRow({
  item,
  chars,
  busy,
  onSave,
  onRemove,
}: {
  item: AssistantMemoryItem;
  chars: number;
  busy: boolean;
  onSave: (content: string) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  if (editing !== null)
    return (
      <li className="ga-memory-item">
        <textarea
          aria-label="编辑这条记忆"
          rows={2}
          maxLength={chars}
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          autoFocus
        />
        <span className="ga-memory-actions">
          <button type="button" onClick={() => setEditing(null)}>
            取消
          </button>
          {/* 面板里实心主按钮只留上面的“记住”，这里用普通按钮 */}
          <button
            type="button"
            disabled={!editing.trim() || busy}
            onClick={async () => {
              if (await onSave(editing.trim())) setEditing(null);
            }}
          >
            保存
          </button>
        </span>
      </li>
    );
  return (
    <li className="ga-memory-item">
      <p>{item.content}</p>
      <small>
        {beijingTime(item.createdAt, 'date')} · {item.source === 'manual' ? '自己加的' : '助手记的'}
        {item.updatedAt.slice(0, 16) !== item.createdAt.slice(0, 16) && ' · 改过'}
      </small>
      <span className="ga-memory-actions">
        <button type="button" disabled={busy} onClick={() => setEditing(item.content)}>
          改
        </button>
        <button type="button" className="danger-text" disabled={busy} onClick={onRemove}>
          删
        </button>
      </span>
    </li>
  );
}

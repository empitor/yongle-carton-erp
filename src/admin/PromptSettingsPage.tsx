import { Plus, Check } from 'lucide-react';
import PromptEditor from './PromptEditor';
import { FormMessage } from '../ui/index';
import { ConfirmDialog } from '../ui/index';
import { SuperModeNotice } from '../ui/index';
import type { PromptModuleId } from '../../shared/ai/index';
import { usePromptPresets, type PromptPresets } from './usePromptPresets';

/** 一个模块最多存几份预设 */
const MAX_PRESETS = 50;

/**
 * 设置 → 提示词：左边是预设列表（启用哪一份），右边编辑选中的那份（PromptEditor）。
 * 提示词要超级管理员账号进了超级管理员模式才能改（服务端拒收别的修改）；editable 为 false 时整页只读。
 * 数据和动作在 usePromptPresets。
 */
export default function PromptSettingsPage({
  module,
  purpose = 'recognition',
  editable = true,
}: {
  /** 提示词模块（地址 /api/ai/prompt-modules/模块） */
  module: PromptModuleId;
  purpose?: 'recognition' | 'assistant';
  /** 能不能改：超级管理员模式里才能（判断在设置页 AiSettingsHub） */
  editable?: boolean;
}) {
  const assistant = purpose === 'assistant';
  const presets = usePromptPresets(module, assistant);
  const { state, current, busy, error, guard } = presets;
  return (
    <div className="adm-prompt">
      <FormMessage
        action={
          <button
            className="secondary adm-prompt-refresh"
            disabled={busy}
            onClick={() => guard(() => window.location.reload())}
          >
            刷新
          </button>
        }
      >
        {error}
      </FormMessage>
      {/* 这一页只给超级管理员账号：没进模式时给进入的入口 */}
      {!editable && <SuperModeNotice what="改提示词" />}
      <FormMessage tone="info">{presets.notice}</FormMessage>
      <div className="adm-prompt-layout">
        <PresetList presets={presets} assistant={assistant} editable={editable} />
        {current && (
          <PromptEditor
            current={current}
            setCurrent={presets.setCurrent}
            state={state}
            saved={presets.saved}
            dirty={presets.dirty}
            busy={busy}
            editable={editable}
            assistant={assistant}
            command={presets.command}
            save={(activate) => void presets.save(activate)}
          />
        )}
      </div>
      <PendingDialogs presets={presets} />
    </div>
  );
}

/** 左边的预设列表：每份写启用了几条，正在用的标“使用中”，别的能“启用”；能改时可以新建 */
function PresetList({
  presets,
  assistant,
  editable,
}: {
  presets: PromptPresets;
  assistant: boolean;
  editable: boolean;
}) {
  const { state, current, busy } = presets;
  return (
    <aside className="adm-prompt-list" aria-label={assistant ? '助手预设' : '识别预设'}>
      <header>
        <h3>
          {assistant ? '助手预设' : '识别预设'} <small>{state?.presets.length || 0}/{MAX_PRESETS}</small>
        </h3>
        {editable && (
          <button
            className="secondary"
            disabled={!state || busy || state.presets.length >= MAX_PRESETS}
            onClick={presets.newPreset}
            title="新建预设"
            aria-label="新建提示词预设"
          >
            <Plus size={14} aria-hidden="true" />
            新建
          </button>
        )}
      </header>
      <ul>
        {state?.presets.map((p) => (
          <li className={current?.id === p.id ? 'selected' : ''} key={p.id}>
            <button className="adm-prompt-select" disabled={busy} onClick={() => presets.select(p)}>
              <strong>{p.name}</strong>
              <small>
                {p.entries.filter((e) => e.enabled).length} / {p.entries.length} 条启用
              </small>
            </button>
            {p.id === state.activeId ? (
              <span className="adm-ai-current">
                <Check size={12} aria-hidden="true" />
                使用中
              </span>
            ) : (
              editable && (
                <button
                  className="secondary adm-ai-use"
                  disabled={busy}
                  aria-label={'启用 ' + p.name}
                  onClick={() => presets.command('activate', p.id)}
                >
                  启用
                </button>
              )
            )}
          </li>
        ))}
      </ul>
      <p className="adm-prompt-tip">只有启用的条目会按顺序发给 AI；关掉的条目内容保留。</p>
    </aside>
  );
}

/** 要先确认的几件事：放弃未保存的修改、删除预设、恢复默认条目 */
function PendingDialogs({ presets }: { presets: PromptPresets }) {
  const { pending, setPending, busy, perform } = presets;
  if (pending?.kind === 'leave')
    return (
      <ConfirmDialog
        title="放弃未保存的修改？"
        confirmLabel="放弃修改"
        cancelLabel="继续编辑"
        danger
        close={() => setPending(null)}
        onConfirm={() => {
          const run = pending.run;
          setPending(null);
          run();
        }}
      >
        <p>当前提示词有未保存修改，继续的话这些修改会丢掉。</p>
      </ConfirmDialog>
    );
  if (pending?.kind === 'delete')
    return (
      <ConfirmDialog
        title="删除提示词预设"
        confirmLabel="删除预设"
        danger
        busy={busy}
        close={() => setPending(null)}
        onConfirm={() => {
          const id = pending.id;
          setPending(null);
          void perform('delete', id);
        }}
      >
        <p>确定删除这份提示词预设？若它正在使用，将切换到剩余的第一份预设。已有的订单识别结果不会删除。</p>
      </ConfirmDialog>
    );
  if (pending?.kind === 'restore')
    return (
      <ConfirmDialog
        title="恢复默认条目"
        confirmLabel="恢复并保存"
        busy={busy}
        close={() => setPending(null)}
        onConfirm={() => {
          const id = pending.id;
          setPending(null);
          void perform('restore', id);
        }}
      >
        <p>将此预设的条目恢复为标准默认规则并立即保存。保留已保存的预设名称，未保存修改会丢弃。</p>
      </ConfirmDialog>
    );
  return null;
}

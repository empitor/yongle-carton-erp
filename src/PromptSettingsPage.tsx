import { useEffect, useState } from 'react';
import {
  Plus,
  Copy,
  Trash2,
  ArrowUp,
  ArrowDown,
  RotateCcw,
  Save,
  Check,
  ListOrdered,
} from 'lucide-react';
import type { PromptPreset, PromptSettingsView } from '../shared/prompt-presets';
import './prompt-settings.css';

export default function PromptSettingsPage({
  baseUrl = '/api/ai/prompts',
  purpose = 'recognition',
}: {
  baseUrl?: string;
  purpose?: 'recognition' | 'assistant';
}) {
  const assistant = purpose === 'assistant';
  const [state, setState] = useState<PromptSettingsView | null>(null),
    [current, setCurrent] = useState<PromptPreset | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const saved = state?.presets.find((p) => p.id === current?.id),
    dirty = !!current && JSON.stringify(current) !== JSON.stringify(saved),
    active = state?.presets.find((p) => p.id === state.activeId);
  function accept(next: PromptSettingsView, id?: string) {
    setState(next);
    setCurrent(
      structuredClone(
        next.presets.find((p) => p.id === id) || next.presets.find((p) => p.id === next.activeId)!,
      ),
    );
  }
  useEffect(() => {
    let live = true;
    fetch(baseUrl, { cache: 'no-store' })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.message || '无法读取提示词预设');
        return d;
      })
      .then((d) => {
        if (live) accept(d);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [baseUrl]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const leave = () => !dirty || window.confirm('当前提示词有未保存修改，是否放弃这些修改？');
  async function send(action: string, body: Record<string, unknown>) {
    if (!state) return null;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await fetch(baseUrl + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ERP-AI-Token': state.csrfToken },
        body: JSON.stringify({ expectedRevision: state.revision, ...body }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || '操作失败');
      return d as PromptSettingsView;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function save(activate = false) {
    if (!current) return;
    const next = await send('save', { preset: current, activate });
    if (next) {
      accept(next, current.id);
      setNotice(
        activate
          ? '提示词已保存并启用，下一次AI请求将使用这份规则。'
          : '提示词已保存到本机数据库。',
      );
    }
  }
  async function command(action: 'copy' | 'activate' | 'delete' | 'restore', id: string) {
    if (!leave()) return;
    if (
      action === 'delete' &&
      !window.confirm(
        '确定删除这份提示词预设？若它正在使用，将切换到剩余的第一份预设。已有订单草稿不会删除。',
      )
    )
      return;
    if (
      action === 'restore' &&
      !window.confirm(
        '将此预设的条目恢复为标准默认规则并立即保存。保留已保存的预设名称，未保存修改会丢弃。是否继续？',
      )
    )
      return;
    const next = await send(action, {
      id,
      ...(['delete', 'restore'].includes(action) ? { confirmed: true } : {}),
    });
    if (next) {
      const selected =
        action === 'copy'
          ? next.presets.find((p) => !state!.presets.some((old) => old.id === p.id))?.id
          : action === 'delete'
            ? undefined
            : id;
      accept(next, selected);
      setNotice(
        {
          copy: '已复制预设，可编辑副本后启用。',
          activate: '已切换当前使用的提示词。',
          delete: '提示词预设已删除。',
          restore: '已恢复默认条目并保存。',
        }[action],
      );
    }
  }
  function newPreset() {
    if (leave()) {
      setCurrent({
        id: crypto.randomUUID(),
        name: assistant ? '新助手预设' : '新识别预设',
        entries: [
          {
            id: crypto.randomUUID(),
            name: assistant ? '自定义助手规则' : '自定义识别规则',
            content: '',
            enabled: true,
          },
        ],
      });
      setNotice('填写名称和条目后，点击保存。');
      setError('');
    }
  }
  function entry(index: number, patch: Partial<PromptPreset['entries'][number]>) {
    setCurrent((p) =>
      p ? { ...p, entries: p.entries.map((e, i) => (i === index ? { ...e, ...patch } : e)) } : p,
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
  return (
    <div className="prompt-settings">
      <section className="prompt-active">
        <ListOrdered size={25} />
        <div>
          <small>{assistant ? '当前使用的全局助手预设' : '当前使用的识别预设'}</small>
          <strong>{active?.name || '正在读取…'}</strong>
          <p>
            {assistant
              ? '保存后应用于下一次全局助手消息；与文件识别预设独立保存。'
              : '保存后应用于下一次识别和聊天；已有草稿保持原样。'}
          </p>
        </div>
        <a href="#ai-settings">AI 服务设置</a>
      </section>
      {error && (
        <div className="prompt-error" role="alert">
          {error}
          <button
            disabled={busy}
            onClick={() => {
              if (leave()) window.location.reload();
            }}
          >
            重新加载
          </button>
        </div>
      )}
      {notice && (
        <div className="prompt-notice" role="status">
          {notice}
        </div>
      )}
      <div className="prompt-layout">
        <aside className="prompt-list">
          <header>
            <h2>
              {assistant ? '助手预设' : '识别预设'} <small>{state?.presets.length || 0}/50</small>
            </h2>
            <button
              disabled={!state || busy || state.presets.length >= 50}
              onClick={newPreset}
              title="新建预设"
              aria-label="新建提示词预设"
            >
              <Plus size={17} />
            </button>
          </header>
          {state?.presets.map((p) => (
            <article className={current?.id === p.id ? 'selected' : ''} key={p.id}>
              <button
                className="prompt-select"
                disabled={busy}
                onClick={() => {
                  if (current?.id !== p.id && leave()) {
                    setCurrent(structuredClone(p));
                    setError('');
                    setNotice('');
                  }
                }}
              >
                <b>{p.name}</b>
                <small>
                  {p.entries.filter((e) => e.enabled).length} / {p.entries.length} 条启用{' '}
                  {p.id === state.activeId && <span>当前使用</span>}
                </small>
              </button>
              <button
                className="prompt-use"
                disabled={busy || p.id === state.activeId}
                onClick={() => void command('activate', p.id)}
              >
                {p.id === state.activeId ? (
                  <>
                    <Check size={13} />
                    已启用
                  </>
                ) : (
                  '切换使用'
                )}
              </button>
            </article>
          ))}
          <p>仅启用的条目会按顺序发送给AI。关闭条目会保留内容。</p>
        </aside>
        {current && (
          <section className="prompt-editor">
            <header>
              <label>
                预设名称
                <input
                  aria-label="提示词预设名称"
                  value={current.name}
                  maxLength={80}
                  disabled={busy}
                  onChange={(e) => setCurrent({ ...current, name: e.target.value })}
                />
              </label>
              <span>
                {dirty ? '有未保存修改' : '已保存'}
                {current.id === state?.activeId ? ' · 当前使用' : ''}
              </span>
            </header>
            <div className="prompt-tools">
              <button
                disabled={busy || !saved || dirty}
                title={dirty ? '先保存修改后再复制' : '复制已保存预设'}
                onClick={() => void command('copy', current.id)}
              >
                <Copy size={14} />
                复制预设
              </button>
              <button disabled={busy || !saved} onClick={() => void command('restore', current.id)}>
                <RotateCcw size={14} />
                恢复默认条目
              </button>
              <button
                className="danger"
                disabled={busy || !saved || state!.presets.length === 1}
                onClick={() => void command('delete', current.id)}
              >
                <Trash2 size={14} />
                删除预设
              </button>
            </div>
            <div className="prompt-entry-list">
              {current.entries.map((e, i) => (
                <article key={e.id} className={'prompt-entry ' + (!e.enabled ? 'is-off' : '')}>
                  <header>
                    <span className="prompt-order">{i + 1}</span>
                    <input
                      aria-label={'条目' + (i + 1) + '名称'}
                      value={e.name}
                      maxLength={80}
                      disabled={busy}
                      onChange={(v) => entry(i, { name: v.target.value })}
                    />
                    <label>
                      <input
                        type="checkbox"
                        aria-label={'启用条目' + (i + 1)}
                        checked={e.enabled}
                        disabled={busy}
                        onChange={(v) => entry(i, { enabled: v.target.checked })}
                      />
                      启用
                    </label>
                    <button
                      aria-label={'上移条目' + (i + 1)}
                      disabled={busy || i === 0}
                      onClick={() => move(i, -1)}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      aria-label={'下移条目' + (i + 1)}
                      disabled={busy || i === current.entries.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      aria-label={'删除条目' + (i + 1)}
                      disabled={busy}
                      onClick={() =>
                        setCurrent({
                          ...current,
                          entries: current.entries.filter((x) => x.id !== e.id),
                        })
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </header>
                  <textarea
                    aria-label={'条目' + (i + 1) + '内容'}
                    rows={5}
                    maxLength={16000}
                    value={e.content}
                    disabled={busy}
                    placeholder="例如：客户表格中的“品名”实际填写尺寸时，应结合上下文分别填写产品名称和规格型号。"
                    onChange={(v) => entry(i, { content: v.target.value })}
                  />
                  <footer>
                    {e.enabled ? '按当前顺序发送' : '已停用，内容仍保留'}
                    <span>{e.content.length}/16000 字</span>
                  </footer>
                </article>
              ))}
            </div>
            <button
              className="prompt-add"
              disabled={busy || current.entries.length >= 40}
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
              <Plus size={15} />
              添加提示词条目
            </button>
            <div className="prompt-fixed-note">
              <b>程序保留的输出与校验规则</b>
              <p>
                {assistant
                  ? '工具白名单、结构化响应、身份权限、人工确认及业务校验由后端独立执行。提示词不能批准自己的方案，也不能越过权限或执行代码。'
                  : '输出字段、JSON格式、金额重算、人工核对及数据安全限制由程序独立维护。条目内容可自由调整，不能启用正式写入或跳过后端校验。'}
              </p>
            </div>
            <footer className="prompt-save">
              <small>
                {current.entries.reduce((n, e) => n + e.content.length, 0)} / 24000 字 · 最多40条
              </small>
              <button disabled={busy || !dirty || !current.name.trim()} onClick={() => void save()}>
                <Save size={15} />
                保存预设
              </button>
              <button
                className="primary"
                disabled={busy || !current.name.trim()}
                onClick={() => void save(true)}
              >
                {busy ? '正在保存…' : '保存并使用'}
              </button>
            </footer>
          </section>
        )}
      </div>
    </div>
  );
}

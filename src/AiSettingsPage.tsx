import { useEffect, useState } from 'react';
import {
  Bot,
  Cable,
  CheckCircle2,
  CircleAlert,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Wifi,
} from 'lucide-react';
import type {
  AiSettingsView,
  ApiConnectionState,
  ConnectionResult,
  PublicPreset,
  ApiStyle,
} from '../shared/ai-settings';
import './ai-settings.css';

type Form = { id?: string; name: string; endpoint: string; model: string; apiStyle: ApiStyle };
type Message = { ok: boolean; message: string; code?: string };
const empty: Form = { name: '新 API 预设', endpoint: '', model: '', apiStyle: 'chat-completions' };
const labels: Record<string, string> = {
  authentication: '认证失败',
  permission: '访问受限',
  model: '模型或协议不可用',
  quota: '额度不足',
  rate_limit: '请求受限',
  network: '网络错误',
  dns: '域名解析失败',
  tls: '证书校验失败',
  timeout: '连接超时',
  response: '响应格式不兼容',
  endpoint: '请检查 API 地址',
  key_required: '需要填写密钥',
  stale: '配置已变化',
  busy: '正在处理',
  storage: '配置存储失败',
  validation: '请检查输入',
};
const statuses = {
  idle: '尚未连接',
  checking: '正在验证',
  verified: 'API 已连接',
  unverified: '尚未验证',
  failed: '连接失败',
  'model-tested': '模型测试通过',
};
const asForm = (p: PublicPreset): Form => ({
  id: p.id,
  name: p.name,
  endpoint: p.endpoint,
  model: p.model,
  apiStyle: p.apiStyle || 'chat-completions',
});
export default function AiSettingsPage() {
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [form, setForm] = useState<Form>(empty);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState('loading');
  const [models, setModels] = useState<string[]>([]);
  const [manual, setManual] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelNotice, setModelNotice] = useState('连接 API 后会自动读取模型，也可以手动读取。');
  const [connection, setConnection] = useState<ApiConnectionState | null>(null);
  const [testResult, setTestResult] = useState<Message | null>(null);
  const [receipt, setReceipt] = useState('');
  const [notice, setNotice] = useState<Message | null>(null);
  const [deleting, setDeleting] = useState<PublicPreset | null>(null);
  const saved = view?.presets.find((p) => p.id === form.id);
  const savedKey =
    !!saved?.hasApiKey && saved.endpoint === form.endpoint.trim().replace(/\/+$/, '');
  const locked = !!busy || !view || !!view.storageError;
  const errorMessage = (e: unknown): Message => ({
    ok: false,
    code: (e as any)?.code || 'network',
    message:
      e instanceof TypeError
        ? '无法连接本机 ERP 后端，请确认程序已启动。'
        : (e as Error)?.message || '请求失败，请稍后重试。',
  });
  async function request<T>(path = '', body?: unknown): Promise<T> {
    const response = await fetch(
      '/api/ai/settings' + path,
      body === undefined
        ? { cache: 'no-store' }
        : {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-ERP-AI-Token': view?.csrfToken || '',
            },
            body: JSON.stringify(body),
          },
    );
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(data.error?.message || 'ERP 请求失败'), {
        code: data.error?.code || 'network',
      });
    return data;
  }
  const payload = () => ({
    ...form,
    ...(apiKey ? { apiKey } : {}),
    expectedRevision: view!.revision,
  });
  function select(p?: PublicPreset, data = view) {
    setForm(p ? asForm(p) : { ...empty });
    setApiKey('');
    setShowKey(false);
    setReceipt('');
    setModels([]);
    setModelsLoaded(false);
    setManual(false);
    setModelNotice('连接 API 后会自动读取模型，也可以手动读取。');
    setConnection(p && data?.connection.presetId === p.id ? data.connection : null);
    setTestResult(null);
    setNotice(null);
  }
  useEffect(() => {
    let alive = true;
    fetch('/api/ai/settings', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('设置加载失败，请检查后端。');
        return res.json() as Promise<AiSettingsView>;
      })
      .then((data) => {
        if (!alive) return;
        setView(data);
        const p = data.presets.find((p) => p.id === data.lastPresetId) || data.presets[0];
        select(p, data);
      })
      .catch((e) => {
        if (alive) setNotice(errorMessage(e));
      })
      .finally(() => {
        if (alive) setBusy('');
      });
    return () => {
      alive = false;
    };
  }, []);
  // 自动连接是后端启动任务；前端只轮询展示结果，不触发额外推理或重复连接。
  useEffect(() => {
    if (view?.connection.status !== 'checking') return;
    const timer = setInterval(() => {
      request<AiSettingsView>()
        .then((data) => {
          setView(data);
          if (form.id === data.connection.presetId) setConnection(data.connection);
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [view?.connection.status, form.id]);
  function change(patch: Partial<Form>) {
    setForm((f) => ({ ...f, ...patch }));
    setReceipt('');
    setTestResult(null);
    setNotice(null);
    if ('endpoint' in patch || 'apiStyle' in patch) {
      setConnection(null);
      setModels([]);
      setModelsLoaded(false);
      setModelNotice('地址已修改，请重新连接；密钥不会自动发送到新地址。');
    }
  }
  async function loadModels() {
    try {
      const result = await request<{ models: string[]; truncated: boolean }>('/models', payload());
      setModels(result.models);
      setModelsLoaded(true);
      setManual(!result.models.length || (!!form.model && !result.models.includes(form.model)));
      setModelNotice(
        result.models.length
          ? `已读取 ${result.models.length} 个模型${result.truncated ? '（仅显示首批）' : ''}。请选择账号有权限的模型。`
          : '接口没有返回可用模型，请手动输入模型 ID。',
      );
    } catch (e) {
      const failure = errorMessage(e);
      setModelsLoaded(true);
      setManual(true);
      setModelNotice(
        `${labels[failure.code || ''] || '模型列表未获取'}：${failure.message} 可继续手动输入模型 ID 并测试。`,
      );
    }
  }
  async function connect() {
    setBusy('connect');
    setReceipt('');
    setNotice(null);
    setTestResult(null);
    setConnection({
      presetId: form.id || null,
      status: 'checking',
      message: '正在验证 API 地址与凭据…',
    });
    try {
      const result = await request<ApiConnectionState>('/connect', payload());
      setConnection(result);
      setBusy('models');
      await loadModels();
      const data = await request<AiSettingsView>();
      setView(data);
    } catch (e) {
      const m = errorMessage(e);
      setConnection({
        presetId: form.id || null,
        status: 'failed',
        message: m.message,
        code: m.code as any,
      });
    } finally {
      setBusy('');
    }
  }
  async function test() {
    setBusy('test');
    setReceipt('');
    setNotice(null);
    setTestResult(null);
    try {
      const result = await request<ConnectionResult>('/test', payload());
      setReceipt(result.testToken);
      setTestResult({
        ok: true,
        message: `${result.message} 耗时 ${(result.durationMs / 1000).toFixed(2)} 秒。`,
      });
    } catch (e) {
      setTestResult(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  async function save(enable: boolean) {
    setBusy('save');
    setNotice(null);
    try {
      const data = await request<AiSettingsView>(
        enable ? '/save' : '/preset',
        enable ? { testToken: receipt, expectedRevision: view!.revision } : payload(),
      );
      setView(data);
      const p = data.presets.find((p) => p.id === form.id) || data.presets[data.presets.length - 1];
      select(p, data);
      setNotice({
        ok: true,
        message: enable
          ? '已保存并启用。重启程序后仍会保留预设、密钥与模型。'
          : '预设已加密保存，可以稍后再连接；本次未自动启用。',
      });
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  async function activate(p: PublicPreset) {
    setBusy('activate');
    try {
      const data = await request<AiSettingsView>('/activate', {
        id: p.id,
        expectedRevision: view!.revision,
      });
      setView(data);
      select(p, data);
      setNotice({ ok: true, message: '已切换当前预设，点击“连接 API”验证即可，无需重填密钥。' });
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  async function toggleAuto(value: boolean) {
    setBusy('preferences');
    try {
      setView(
        await request<AiSettingsView>('/preferences', {
          autoConnect: value,
          expectedRevision: view!.revision,
        }),
      );
      setReceipt('');
      setNotice({
        ok: true,
        message: value
          ? '已开启启动时自动连接；只进行免费目录检查，不执行模型推理。'
          : '已关闭自动连接；启动后仍恢复配置，等待手动连接。',
      });
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  async function remove() {
    if (!deleting) return;
    setBusy('delete');
    try {
      const data = await request<AiSettingsView>('/delete', {
        id: deleting.id,
        confirmed: true,
        expectedRevision: view!.revision,
      });
      setView(data);
      if (form.id === deleting.id)
        select(data.presets.find((p) => p.id === data.lastPresetId) || data.presets[0], data);
      setDeleting(null);
      setNotice({ ok: true, message: '预设已删除。' });
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  const topConnection =
    view?.active && view.connection.presetId === view.active.id ? view.connection : null;
  return (
    <div className="ai-settings-page">
      <section className="panel ai-overview" aria-label="当前 AI 服务">
        <div className="ai-overview-title">
          <Bot size={23} />
          <div>
            <small>当前使用的 API 预设</small>
            <strong>{view?.active?.name || '尚未启用预设'}</strong>
          </div>
        </div>
        <div>
          <small>
            当前模型 ·{' '}
            {view?.active?.apiStyle === 'responses' ? 'Responses API' : 'Chat Completions'}
          </small>
          <strong>{view?.active?.model || '尚未选择'}</strong>
        </div>
        <div className={`ai-status-tag ${topConnection?.status || ''}`}>
          <i />
          {topConnection ? statuses[topConnection.status] : '尚未连接'}
        </div>
        {topConnection && <p className="ai-overview-message">{topConnection.message}</p>}
      </section>
      {view?.storageError && (
        <div role="alert" className="ai-feedback failed">
          <CircleAlert size={18} />
          <p>{view.storageError}</p>
        </div>
      )}
      {notice && (
        <div
          role={notice.ok ? 'status' : 'alert'}
          className={`ai-feedback ${notice.ok ? 'passed' : 'failed'}`}
        >
          <CircleAlert size={18} />
          <p>
            {notice.code && <strong>{labels[notice.code] || '操作失败'}： </strong>}
            {notice.message}
          </p>
        </div>
      )}
      <div className="ai-settings-grid">
        <aside className="ai-presets panel">
          <div className="ai-presets-title">
            <h2>
              API 预设 <small>{view?.presets.length || 0}</small>
            </h2>
            <button
              aria-label="新建预设"
              title="新建预设"
              disabled={locked}
              onClick={() => select()}
            >
              <Plus size={17} />
            </button>
          </div>
          <div className="ai-preset-list">
            {view?.presets.map((p) => (
              <div key={p.id} className={`ai-preset ${form.id === p.id ? 'selected' : ''}`}>
                <button className="ai-preset-select" onClick={() => select(p)} disabled={locked}>
                  <strong>{p.name}</strong>
                  <span>{p.model || '模型待选'}</span>
                </button>
                <div className="ai-preset-controls">
                  {view.active?.id === p.id ? (
                    <span className="ai-current">当前使用</span>
                  ) : (
                    <button disabled={locked || !p.hasApiKey} onClick={() => activate(p)}>
                      切换使用
                    </button>
                  )}
                  <button
                    aria-label={`删除预设 ${p.name}`}
                    disabled={locked}
                    onClick={() => setDeleting(p)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
            {view && !view.presets.length && (
              <p className="ai-empty">
                还没有连接预设。
                <br />
                填写右侧配置，保存你的第一个 API。
              </p>
            )}
          </div>
          <button className="ai-new-preset" disabled={locked} onClick={() => select()}>
            <Plus size={15} />
            新建预设
          </button>
          <label className="ai-auto">
            <input
              type="checkbox"
              role="switch"
              checked={view?.autoConnect || false}
              disabled={locked}
              onChange={(e) => toggleAuto(e.target.checked)}
            />
            <span>
              启动时自动连接
              <br />
              上次使用的 API
            </span>
          </label>
          <p className="ai-side-help">
            只检查服务与凭据，不执行可能收费的模型推理。配置恢复不等于验证成功。
          </p>
          <label className="ai-auto"><span>同时识别文件数</span><select aria-label="AI识别并发数量" value={view?.recognitionConcurrency||3} disabled={locked} onChange={async e=>{setBusy('preferences');try{setView(await request<AiSettingsView>('/preferences',{expectedRevision:view!.revision,recognitionConcurrency:Number(e.target.value)}));setNotice({ok:true,message:'并发上限已保存；限流时会自动退回串行。'});}catch(error){setNotice(errorMessage(error));}finally{setBusy('');}}}>{[1,2,3,4,5,6].map(n=><option key={n} value={n}>{n===1?'1（串行回退）':n+' 个'}</option>)}</select></label>
          <div className="ai-storage-note">
            <LockKeyhole size={18} />
            <strong>Windows 加密保管</strong>
            <p>密钥由当前 Windows 用户的 DPAPI 加密，关闭程序或重启电脑后仍保留。</p>
            <p>保存的密钥不会传回浏览器。眼睛按钮只显示本次新输入的内容。</p>
          </div>
        </aside>
        <section className="panel ai-editor" aria-label="API 连接配置">
          <div className="ai-editor-heading">
            <h2>{form.id ? '编辑连接预设' : '新建连接预设'}</h2>
            <span>连接 API → 选择模型 → 测试并保存</span>
          </div>
          <div className="ai-name-field">
            <label htmlFor="ai-preset-name">预设名称</label>
            <input
              id="ai-preset-name"
              value={form.name}
              disabled={locked}
              maxLength={60}
              onChange={(e) => change({ name: e.target.value })}
            />
          </div>
          <fieldset disabled={locked} className="ai-workflow">
            <label className="ai-field">
              接口类型
              <input value="自定义兼容 API" readOnly />
            </label>
            <label className="ai-field">
              兼容协议
              <select
                aria-label="兼容协议"
                value={form.apiStyle}
                onChange={(e) => change({ apiStyle: e.target.value as ApiStyle })}
              >
                <option value="chat-completions">Chat Completions（聊天补全）</option>
                <option value="responses">Responses API</option>
              </select>
              {form.apiStyle === 'responses' && (
                <small>
                  可直接提交Word、Excel、PDF原件；实际能力取决于该服务和模型。连接测试不上传业务文件。
                </small>
              )}
            </label>
            <label className="ai-field">
              API 地址
              <input
                type="url"
                value={form.endpoint}
                placeholder="https://api.example.com/v1"
                autoComplete="off"
                onChange={(e) => change({ endpoint: e.target.value })}
              />
              <small>
                支持根域名、/v1 或对应协议的完整{' '}
                {form.apiStyle === 'responses' ? '/responses' : '/chat/completions'} 地址；仅支持
                HTTPS 公网服务。
              </small>
            </label>
            <div className="ai-field">
              <label htmlFor="ai-api-key">
                API Key{' '}
                <span className={savedKey ? 'ai-key-badge configured' : 'ai-key-badge'}>
                  {savedKey ? '•••••••• 已加密配置' : '尚未保存密钥'}
                </span>
              </label>
              <div className="ai-secret-input">
                <input
                  id="ai-api-key"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={savedKey ? '留空继续使用已保存密钥；输入可更换' : '输入 API Key'}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setReceipt('');
                    setConnection(null);
                    setTestResult(null);
                  }}
                />
                <button
                  type="button"
                  aria-label={showKey ? '隐藏本次输入的密钥' : '显示本次输入的密钥'}
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            <button
              className="ai-connect-button"
              disabled={locked || !form.endpoint || (!apiKey && !savedKey)}
              onClick={connect}
            >
              {busy === 'connect' ? (
                <LoaderCircle size={17} className="ai-spin" />
              ) : (
                <Cable size={17} />
              )}
              连接 API
            </button>
            <div className={`ai-connection-state ${connection?.status || 'idle'}`} role="status">
              <Wifi size={18} />
              <div>
                <strong>{connection ? statuses[connection.status] : '等待连接 API'}</strong>
                <p>{connection?.message || '填写地址和密钥后连接。此步骤不进行模型推理。'}</p>
                {connection?.code && <small>{labels[connection.code] || connection.code}</small>}
              </div>
            </div>
            <button
              className="ai-refresh-models"
              disabled={locked || !form.endpoint || (!apiKey && !savedKey)}
              onClick={async () => {
                setBusy('models');
                await loadModels();
                setBusy('');
              }}
            >
              {busy === 'models' ? (
                <LoaderCircle size={16} className="ai-spin" />
              ) : (
                <RefreshCw size={16} />
              )}{' '}
              {modelsLoaded ? '刷新模型列表' : '读取可用模型'}
            </button>
            <div className="ai-field ai-model-field">
              <label htmlFor="ai-model-list">可用模型</label>
              <select
                id="ai-model-list"
                value={manual ? '__manual' : form.model}
                onChange={(e) => {
                  if (e.target.value === '__manual') {
                    setManual(true);
                    change({ model: '' });
                  } else {
                    setManual(false);
                    change({ model: e.target.value });
                  }
                }}
              >
                <option value="">请选择模型</option>
                {!manual && form.model && !models.includes(form.model) && (
                  <option value={form.model}>{form.model}（已保存）</option>
                )}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="__manual">手动输入模型 ID…</option>
              </select>
              <small>{modelNotice}</small>
            </div>
            {manual && (
              <label className="ai-field">
                模型 ID（手动输入）
                <input
                  value={form.model}
                  autoComplete="off"
                  placeholder="填写服务商提供的准确模型 ID"
                  onChange={(e) => change({ model: e.target.value })}
                />
              </label>
            )}
            <button
              className="ai-model-test"
              onClick={test}
              disabled={locked || !form.model || !form.endpoint || (!apiKey && !savedKey)}
            >
              {busy === 'test' ? (
                <LoaderCircle size={17} className="ai-spin" />
              ) : (
                <Wifi size={17} />
              )}{' '}
              {busy === 'test'
                ? '正在测试模型…'
                : form.apiStyle === 'responses'
                  ? '测试 Responses 连接'
                  : '测试连接'}
            </button>
            <small className="ai-test-help">
              通过所选协议发送一次无业务数据的最小请求，可能产生少量API费用。文本测试成功不代表文件输入一定受支持。
            </small>
            {testResult && (
              <div
                role={testResult.ok ? 'status' : 'alert'}
                className={`ai-feedback ${testResult.ok ? 'passed' : 'failed'}`}
              >
                {testResult.ok ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}
                <p>
                  {testResult.code && <strong>{labels[testResult.code] || '测试失败'}： </strong>}
                  {testResult.message}
                </p>
              </div>
            )}
            <div className="ai-save-row">
              <button
                className="primary"
                disabled={locked || !receipt || !form.name.trim()}
                onClick={() => save(true)}
              >
                <Save size={17} />
                {busy === 'save' ? '正在保存…' : '保存并启用'}
              </button>
              <button
                disabled={locked || !form.name.trim() || !form.endpoint || (!apiKey && !savedKey)}
                onClick={() => save(false)}
              >
                仅保存预设
              </button>
            </div>
            <small className="ai-test-help">
              “保存并启用”需要模型测试通过。“仅保存预设”可保存尚未测试的连接。
            </small>
          </fieldset>
          <footer className="ai-editor-footer">
            <ShieldCheck size={16} />
            <p>可前往“AI 智能订单导入”识别文件、聊天修改与核对草稿；正式 ERP 写入保持关闭。</p>
          </footer>
        </section>
      </div>
      {deleting && (
        <div className="ai-dialog-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-delete-title"
            className="panel ai-delete-dialog"
          >
            <h2 id="ai-delete-title">删除 API 预设</h2>
            <p>确定删除“{deleting.name}”及其保存的密钥吗？此操作不会影响客户、产品或订单。</p>
            <div>
              <button disabled={!!busy} onClick={() => setDeleting(null)}>
                取消
              </button>
              <button className="danger" disabled={!!busy} onClick={remove}>
                确认删除
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import ManagementDialog from './ManagementDialog';
import { managementRequest } from './session';
import { recognizedArrivalDraft } from '../shared/arrival-draft';
import { officialDeepSeekEndpoint } from '../shared/assistant-attachments';
import { dateSchema } from '../shared/domain';
import { SseParser } from '../shared/sse';
export default function ReceiptRecognition({
  data,
  close,
  onDraft,
}: {
  data: any;
  close: () => void;
  onDraft: (d: any) => void;
}) {
  const [sources, setSources] = useState<any[]>([]),
    [source, setSource] = useState<any>(null),
    [profile, setProfile] = useState<any>(null),
    [consent, setConsent] = useState(false),
    [stream, setStream] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [progress, setProgress] = useState('');
  useEffect(() => {
    managementRequest<any[]>('/flow/sources')
      .then(setSources)
      .catch((e) => setError(e.message));
    fetch('/api/ai/settings')
      .then((r) => r.json())
      .then((s) => setProfile(s.active))
      .catch(() => setError('无法读取当前AI设置。'));
  }, []);
  async function upload(file: File) {
    setBusy(true);
    setError('');
    setConsent(false);
    try {
      const auth = await fetch('/api/auth/state').then((r) => r.json());
      const r = await fetch('/api/flow/sources/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-ERP-Auth-Token': auth.csrf,
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || '上传失败');
      setSource(d);
      setSources((s) => [d, ...s.filter((x) => x.id !== d.id)]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function analyze() {
    setBusy(true);
    setError('');
    setProgress('正在连接已启用的AI服务…');
    try {
      const auth = await fetch('/api/auth/state').then((r) => r.json()),
        r = await fetch('/api/flow/sources/' + source.id + '/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
          body: JSON.stringify({
            consent,
            policyVersion: 4,
            stream,
            profile: {
              id: profile.id,
              endpoint: profile.endpoint,
              model: profile.model,
              apiStyle: profile.apiStyle || 'chat-completions',
            },
          }),
        });
      if (!r.ok) {
        const d = await r.json();
        throw new Error(d.message || 'AI识别失败');
      }
      let result: any;
      if (!stream) result = await r.json();
      else {
        const reader = r.body!.getReader(),
          decoder = new TextDecoder();
        const parser = new SseParser(({ event, data: text }) => {
          const d = JSON.parse(text);
          if (event === 'error') throw new Error(d.message);
          if (event === 'result') result = d;
          if (event === 'progress')
            setProgress(
              'AI正在识别 · ' +
                Math.floor((d.elapsedMs || 0) / 1000) +
                ' 秒' +
                (d.receivedChars ? ' · 已接收 ' + d.receivedChars + ' 字符' : ''),
            );
        });
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            parser.push(decoder.decode());
            parser.finish();
            break;
          }
          parser.push(decoder.decode(value, { stream: true }));
        }
      }
      if (!result?.result) throw new Error('未收到完整的供应商送货单结果。');
      setSource(result);
      setSources((s) => s.map((x) => (x.id === result.id ? result : x)));
      setProgress('识别完成，请人工核对后生成收货草稿。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function draft() {
    const recognized = recognizedArrivalDraft(source, data.suppliers);
    onDraft({
      ...recognized.draft,
      notes: [recognized.draft.notes, ...recognized.warnings.map((w) => '待核对：' + w)]
        .filter(Boolean)
        .join('\n')
        .slice(0, 2000),
    });
  }
  return (
    <ManagementDialog title="AI识别供应商送货单" close={close} busy={busy}>
      <div className="receipt-ai">
        <p>
          上传原件 → AI识别 → 人工编辑及匹配采购 → 保存草稿 →
          最后核对并确认实收。识别本身不会修改库存。
        </p>
        <label className="flow-upload">
          <strong>选择原始送货文件</strong>
          <input
            type="file"
            accept=".xls,.xlsx,.doc,.docx,.pdf,.jpg,.jpeg,.png"
            disabled={busy}
            onChange={(e) => {
              if (e.target.files?.[0]) void upload(e.target.files[0]);
              e.target.value = '';
            }}
          />
          <span>图片、PDF、Word、Excel · 最大10MB · 原文件直传</span>
        </label>
        <label className="op-field">
          <span>已有送货文件 / 识别结果</span>
          <select
            value={source?.id || ''}
            disabled={busy}
            onChange={(e) => {
              setSource(sources.find((s) => s.id === e.target.value) || null);
              setConsent(false);
            }}
          >
            <option value="">选择已保存的文件</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.fileName}
                {s.result ? ' · 已识别' : ''}
              </option>
            ))}
          </select>
        </label>
        {source && (
          <>
            <p>
              <strong>{source.fileName}</strong> ·{' '}
              <a href={'/api/flow/sources/' + source.id + '/file'} target="_blank" rel="noreferrer">
                查看原件
              </a>
            </p>
            {!source.result && (
              <>
                <div className="flow-warning">
                  <strong>数据外发确认</strong>
                  <p>
                    将向 {profile?.endpoint || '尚未启用AI服务'} 的 {profile?.model || '未选择模型'}{' '}
                    {officialDeepSeekEndpoint(profile?.endpoint || '')
                      ? '发送本次文件的兼容提取文字或扫描页图片；原图原件保留，不执行OCR，文档排版及内嵌图片可能缺失。'
                      : '发送本次完整送货文件。'}{' '}
                    内容可能包含供应商、收货方、联系人、单号、规格、数量和价格，以及供应商识别提示词；不会发送ERP档案库或库存库。
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={consent}
                      disabled={busy}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    我同意将此文件发送给所示AI服务处理
                  </label>
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={stream}
                    disabled={busy}
                    onChange={(e) => setStream(e.target.checked)}
                  />
                  流式传输（仅完整结束后保存结果）
                </label>
                <p>
                  <a href="#ai-settings?tab=prompts" onClick={close}>
                    编辑供应商识别提示词
                  </a>
                </p>
                {profile?.apiStyle !== 'responses' && (
                  <p className="form-error">
                    请先在AI设置启用Responses协议。第三方网关和模型必须实际支持原始文件输入。
                  </p>
                )}
                <button
                  className="primary"
                  disabled={
                    busy || !consent || !profile?.hasApiKey || profile?.apiStyle !== 'responses'
                  }
                  onClick={analyze}
                >
                  {busy ? '正在识别…' : '开始真实AI识别'}
                </button>
              </>
            )}
            {source.result && (
              <>
                <h3>
                  {source.result.supplierName || '供应商待确认'} ·{' '}
                  {source.result.reference || '送货单号待确认'}
                </h3>
                <p>
                  {source.result.date || '日期待确认'} · {source.result.lines.length} 种纸板
                </p>
                <div className="table-wrap">
                  <table className="flow-table">
                    <thead>
                      <tr>
                        <th>纸板名称</th>
                        <th>规格 / 材质 / 楞型</th>
                        <th>原单数量</th>
                        <th>面积 m²</th>
                        <th>单价</th>
                      </tr>
                    </thead>
                    <tbody>
                      {source.result.lines.map((l: any, i: number) => (
                        <tr key={i}>
                          <td>{l.name || '待确认'}</td>
                          <td>
                            {l.specification} · {l.material} · {l.flute}
                            <span className="sub">
                              {l.length} × {l.width} {l.dimensionUnit || '单位待确认'}
                            </span>
                          </td>
                          <td>
                            {l.quantity || '待确认'} {l.unit || '单位待确认'}
                          </td>
                          <td>{l.area || '待确认'}</td>
                          <td>{l.unitPrice || '待确认'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {source.result.warnings.map((w: string) => (
                  <p className="flow-warning" key={w}>
                    {w}
                  </p>
                ))}
                <button className="primary" onClick={draft}>
                  进入可编辑核对与采购匹配
                </button>
              </>
            )}
          </>
        )}
        {progress && <p role="status">{progress}</p>}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
    </ManagementDialog>
  );
}

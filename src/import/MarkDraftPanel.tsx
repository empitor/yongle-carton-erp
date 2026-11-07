import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, LoaderCircle, ShieldCheck } from 'lucide-react';
import { officialDeepSeekEndpoint } from '../../shared/assistant-attachments';
import { matchMarkToProducts, type MarkCandidate } from '../../shared/mark-matching';
import Combobox from '../ui/Combobox';
import { useAuthState } from '../session';

const choiceValue = (item: any) =>
  item.choice?.mode === 'existing'
    ? String(item.choice.id)
    : item.choice?.mode === 'new'
      ? 'new'
      : '';

/** 唛头核对：左边看原件的这一页，右边逐款对应产品，确认后存进产品档案。 */
export default function MarkDraftPanel({
  fileId,
  aiStatus,
  request,
  stream,
  reload,
  setNotice,
  page,
  onPage,
}: {
  fileId: string;
  aiStatus: any;
  request: <T>(path: string, body?: unknown, onProgress?: (p: any) => void) => Promise<T>;
  stream: boolean;
  reload: () => Promise<unknown>;
  setNotice: (text: string) => void;
  page: number;
  onPage: (page: number) => void;
}) {
  const auth = useAuthState(),
    canEdit =
      !!auth?.actor &&
      (auth.actor.superAdminMode || auth.actor.permissions.includes('business:edit'));
  const [review, setReview] = useState<any>(null),
    [products, setProducts] = useState<any[]>([]),
    [items, setItems] = useState<any[]>([]),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(''),
    [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const committed = !!review?.committed;
  const load = async () => {
    const state = await request<any>('/' + fileId + '/marks');
    setReview(state.review);
    setProducts(state.products || []);
    setItems(state.review?.items || []);
    setDirty(false);
    if (state.review?.items?.[0] && !page) onPage(state.review.items[0].page || 0);
  };
  useEffect(() => {
    setError('');
    void load().catch((e) => setError(e.message));
  }, [fileId]);
  // 改料号或尺寸后立刻重算候选，规则和服务端用同一个函数
  const candidates = useMemo(
    () =>
      Object.fromEntries(items.map((item) => [item.key, matchMarkToProducts(item.fields, products)])) as Record<string, MarkCandidate[]>,
    [items, products],
  );
  const patch = (key: string, delta: any) => {
    setDirty(true);
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...delta } : i)));
  };
  const field = (item: any, name: string, value: string | null) =>
    patch(item.key, { fields: { ...item.fields, [name]: value || null } });
  const pending = items.filter((i) => !i.skip && (i.choice?.mode ?? 'pending') === 'pending').length,
    saving = items.filter((i) => !i.skip).length;
  const work = async (job: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await job();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setProgress('');
    }
  };
  const recognize = () => {
    const active = aiStatus?.active;
    if (!active) {
      setError('请先在设置中启用 AI 预设。');
      return;
    }
    const scope = officialDeepSeekEndpoint(active.endpoint)
      ? '图片发送原图；文档在本机提取兼容文字，扫描 PDF 转页图片。'
      : '发送当前完整原件。';
    if (
      !window.confirm(
        '将向 ' +
          active.endpoint +
          ' 的 ' +
          active.model +
          ' 发送这份唛头文件及专用提示词。' +
          scope +
          '不会发送产品档案和其他业务数据，可能产生模型费用。是否继续？',
      )
    )
      return;
    void work(async () => {
      await request(
        '/' + fileId + '/marks/recognize',
        {
          consent: true,
          stream,
          force: !!review,
          policyVersion: 4,
          profile: {
            id: active.id,
            endpoint: active.endpoint,
            model: active.model,
            apiStyle: active.apiStyle || 'chat-completions',
          },
        },
        (p) => setProgress('识别中 · 已接收 ' + (p.receivedChars || 0) + ' 字符'),
      );
      await reload();
      await load();
    });
  };
  /** 保存选择再存档，一次点击完成；存档由服务端单事务处理，重复提交不会多存。 */
  const commit = () =>
    void work(async () => {
      let current = await request<any>('/' + fileId);
      if (dirty) {
        const r = await fetch('/api/ai/imports/' + fileId + '/marks', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-ERP-AI-Token': aiStatus?.csrfToken || '',
          },
          body: JSON.stringify({ expectedRevision: current.revision, items }),
        });
        if (!r.ok) throw new Error((await r.json()).message || '保存失败');
        current = await request<any>('/' + fileId);
      }
      await request('/' + fileId + '/marks/commit', {
        expectedRevision: current.revision,
        requestId: requestId.current,
      });
      setNotice('原文件已挂到产品下，共 ' + saving + ' 款。');
      window.dispatchEvent(new Event('erp-business-changed'));
      await reload();
      await load();
    });

  return (
    <>
      <section className="oi-draft oi-mark-draft">
        {error && (
          <div className="oi-alert" role="alert">
            {error}
          </div>
        )}
        {progress && (
          <div className="oi-stream-progress" role="status">
            <LoaderCircle className="spin" size={14} />
            <span>{progress}</span>
          </div>
        )}
        {!items.length ? (
          <div className="oi-empty">
            <FileText size={30} />
            <p>还没有识别</p>
            <span>识别名称和尺寸，自动对应产品并把原文件挂上去。对不上的再选一下。唛头不产生订单、生产或库存。</span>
            <button className="primary" disabled={busy || !canEdit} onClick={recognize}>
              {busy ? '正在识别…' : '开始识别'}
            </button>
          </div>
        ) : (
          <div className="oi-draft-content">
            {!committed && (
              <div className="oi-mark-toolbar">
                <span>识别到 {items.length} 款</span>
                {!!review?.warnings?.length && (
                  <small title={review.warnings.join('\n')}>有 {review.warnings.length} 条提醒</small>
                )}
                <button disabled={busy || !canEdit} onClick={recognize}>
                  重新识别
                </button>
              </div>
            )}
            {items.map((item) => {
              const list = candidates[item.key] || [],
                value = choiceValue(item),
                top = list[0];
              return (
                <article
                  key={item.key}
                  className={
                    'oi-mark-item' +
                    (item.page === page ? ' active' : '') +
                    (item.skip ? ' skipped' : '')
                  }
                  aria-label={'第' + (item.page || 1) + '页唛头'}
                  onClick={(e) => {
                    if (!(e.target as HTMLElement).closest('input,select,button,[role="listbox"]'))
                      onPage(item.page || 0);
                  }}
                >
                  <button
                    className="oi-mark-page"
                    aria-label={'查看第' + (item.page || 1) + '页'}
                    onClick={() => onPage(item.page || 0)}
                  >
                    {item.page ? 'P' + item.page : '图'}
                  </button>
                  <details className="oi-mark-fields">
                    <summary>
                      识别内容（用来对应产品）：
                      {[
                        item.fields.itemCode,
                        item.fields.productName,
                        [item.fields.cartonLength, item.fields.cartonWidth, item.fields.cartonHeight]
                          .filter(Boolean)
                          .join('×') + (item.fields.dimensionUnit ? ' ' + item.fields.dimensionUnit : ''),
                      ]
                        .filter(Boolean)
                        .join(' · ') || '没有识别到'}
                    </summary>
                  <label>
                    料号 / 款号
                    <input
                      aria-label={item.key + ' 料号'}
                      disabled={committed || busy}
                      value={item.fields.itemCode ?? ''}
                      onChange={(e) => field(item, 'itemCode', e.target.value)}
                    />
                  </label>
                  <div className="oi-mark-size">
                    <span>尺寸</span>
                    <div>
                      {(['cartonLength', 'cartonWidth', 'cartonHeight'] as const).map((k, n) => (
                        <input
                          key={k}
                          aria-label={item.key + ' ' + ['长', '宽', '高'][n]}
                          disabled={committed || busy}
                          value={item.fields[k] ?? ''}
                          onChange={(e) => field(item, k, e.target.value)}
                        />
                      ))}
                      <select
                        aria-label={item.key + ' 尺寸单位'}
                        disabled={committed || busy}
                        value={item.fields.dimensionUnit ?? ''}
                        onChange={(e) => field(item, 'dimensionUnit', e.target.value)}
                      >
                        <option value="">单位?</option>
                        <option value="cm">cm</option>
                        <option value="mm">mm</option>
                      </select>
                      <select
                        aria-label={item.key + ' 内径或外箱'}
                        disabled={committed || busy}
                        value={item.fields.dimensionBasis ?? 'unknown'}
                        onChange={(e) => field(item, 'dimensionBasis', e.target.value)}
                      >
                        <option value="unknown">内外未知</option>
                        <option value="inner">内径</option>
                        <option value="outer">外箱</option>
                      </select>
                    </div>
                  </div>
                  </details>
                  <label className="oi-mark-product">
                    对应产品
                    <Combobox
                      ariaLabel={item.key + ' 对应产品'}
                      disabled={committed || busy || item.skip}
                      placeholder="待确认，搜索产品"
                      value={value}
                      onChange={(v) =>
                        patch(item.key, {
                          choice: !v
                            ? { mode: 'pending' }
                            : v === 'new'
                              ? {
                                  mode: 'new',
                                  name: item.fields.itemCode || item.fields.productName || item.title || '',
                                  customerProductCode: item.fields.itemCode || null,
                                }
                              : { mode: 'existing', id: Number(v) },
                        })
                      }
                      options={[
                        { value: '', label: '待确认' },
                        {
                          value: 'new',
                          label: '新建产品',
                          hint: item.fields.itemCode || item.fields.productName || '',
                        },
                        ...list.map((c) => ({
                          value: String(c.id),
                          label: c.name,
                          hint: c.reasons.join('、'),
                        })),
                        ...products
                          .filter((p) => !list.some((c) => c.id === p.id))
                          .map((p) => ({
                            value: String(p.id),
                            label: p.name,
                            hint: p.customerProductCode || '',
                          })),
                      ]}
                    />
                  </label>
                  <label className="oi-mark-skip">
                    <input
                      type="checkbox"
                      disabled={committed || busy}
                      checked={!!item.skip}
                      onChange={(e) => patch(item.key, { skip: e.target.checked })}
                    />
                    不挂
                  </label>
                  <p
                    className={
                      'oi-mark-note' +
                      (!item.skip && !value ? ' needs-attention' : '') +
                      (top?.conflicts?.length ? ' needs-attention' : '')
                    }
                  >
                    {item.skip
                      ? '这一款不挂'
                      : value === 'new'
                        ? '新建产品，只带料号，不写入尺寸'
                        : value
                          ? (list.find((c) => String(c.id) === value)?.reasons.join('、') ||
                              '人工选择') +
                            (list.find((c) => String(c.id) === value)?.conflicts.length
                              ? '；' + list.find((c) => String(c.id) === value)!.conflicts.join('、')
                              : '')
                          : list.length
                            ? '有 ' + list.length + ' 个候选，请选一下'
                            : '没有找到对应产品，可搜索或新建'}
                    {item.fields.quantityPerCarton ? ' · ' + item.fields.quantityPerCarton : ''}
                    {item.fields.requirements ? ' · ' + item.fields.requirements : ''}
                  </p>
                </article>
              );
            })}
          </div>
        )}
      </section>
      {!!items.length && (
        <footer className="oi-action-bar">
          <div className="oi-action-summary">
            <span>
              共 <b>{items.length}</b> 款
            </span>
            {committed ? (
              <small>原文件已挂到产品下，产品详情里可以预览</small>
            ) : pending > 0 ? (
              <span className="oi-mark-pending">还有 {pending} 款没对应上产品，请选一下</span>
            ) : (
              <small>将挂到产品下 {saving} 款</small>
            )}
          </div>
          <div className="oi-action-buttons">
            {committed ? (
              <a className="oi-imported-link" href="#products">
                <ShieldCheck size={14} />
                查看产品档案
              </a>
            ) : (
              <button
                className="primary"
                disabled={busy || !canEdit || pending > 0 || saving === 0}
                title={pending ? '还有 ' + pending + ' 款没有确认对应的产品' : undefined}
                onClick={commit}
              >
                {busy ? '处理中…' : '挂到产品下'}
              </button>
            )}
          </div>
        </footer>
      )}
    </>
  );
}

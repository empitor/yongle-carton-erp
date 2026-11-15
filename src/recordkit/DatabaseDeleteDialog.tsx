import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ManagementDialog } from '../ui/index';
import { useAuthState } from '../ui/index';
import { executeDeletion, previewDeletion, type DeletionModule } from './record-api';
import { PasswordField } from '../ui/index';
import DeletionImpact from './DeletionImpact';
import { deletionDoneMessage } from './deletion-impact';
import { deleteOrRepreview } from './deletion-retry';
import { deletionHeadline, type DeletionApi } from '../../shared/business/index';
import { errorMessage } from '../../shared/core/index';
import { EditorFooter, FormField, FormMessage, FormSection } from '../ui/index';
import { emit } from '../ui/index';
import { inventoryOptions } from '../../shared/business/index';

/** 要删的一条：编号和版本号；单据带状态（还没核对的不用再输密码），名字用单号或名称 */
type DeletableRow = { id: number; version: number; status?: string; number?: string; name?: string };
type Preview = DeletionApi['POST /deletions/preview']['response'];
type InventoryPolicy = Preview['selection']['inventoryPolicy'];

const items = (rows: DeletableRow[]) => rows.map((r) => ({ id: r.id, version: r.version }));
/** 等着重查结果的那一方：查成了 done，没查成 failed（带查清单的出错） */
type Waiter = { done: () => void; failed: (e: unknown) => void };

/**
 * 查会一起处理的记录：打开、换了库存处理方式、要删的记录（编号、版本）变了时重新查；删除被拒是因为预览以后数据变了时，
 * repreview 再查一次。choice 是上一次查到的“要按库存处理方式处理的流水笔数”：查询失败时也知道要不要显示库存选项。
 */
function useDeletionPreview(module: DeletionModule, rows: DeletableRow[], policy: InventoryPolicy) {
  const [plan, setPlan] = useState<Preview | null>(null),
    [choice, setChoice] = useState(0),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    // 加一就按同样的选择再查一次（删除被拒、预览以后数据变了）
    [round, setRound] = useState(0);
  // 只在编号、版本变了时重查：页面重画时传进来的是新数组，内容没变不重查；查的时候取最新的那份
  const latestRows = useRef(rows);
  useEffect(() => {
    latestRows.current = rows;
  });
  const rowsKey = rows.map((r) => r.id + ':' + r.version).join(',');
  // 删除被拒后要求的那次重查：查完（查成或没查成）告诉等它的删除，查成了才说“已换成最新的清单”
  const waiting = useRef<Waiter | null>(null);
  useEffect(() => {
    let active = true;
    const settle = (tell: (w: Waiter) => void) => {
      const w = waiting.current;
      waiting.current = null;
      if (w) tell(w);
    };
    setBusy(true);
    setError('');
    setPlan(null);
    previewDeletion({ module, items: items(latestRows.current), inventoryPolicy: policy })
      .then((p) => {
        if (!active) return;
        setPlan(p);
        setChoice(p.inventoryChoice);
        setBusy(false);
        settle((w) => w.done());
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError(errorMessage(e));
        setBusy(false);
        settle((w) => w.failed(e));
      });
    return () => {
      active = false;
    };
  }, [module, policy, rowsKey, round]);
  /** 按同样的选择再查一次，查完才交回（没查成交回查清单的出错） */
  const repreview = () =>
    new Promise<void>((done, failed) => {
      waiting.current = { done, failed };
      setRound((n) => n + 1);
    });
  return { plan, choice, busy, setBusy, error, setError, repreview };
}

/** 会删到库存流水或已生效的单据时，焦点先放在“取消” */
function DeleteFooter(o: {
  busy: boolean;
  ready: boolean;
  alarming: boolean;
  label: string;
  close: () => void;
  confirm: () => void;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (o.alarming) cancelButton.current?.focus();
  }, [o.alarming]);
  return (
    <EditorFooter note="删除前系统会自动留一份恢复快照。">
      <button ref={cancelButton} type="button" className="secondary" disabled={o.busy} onClick={o.close}>
        取消
      </button>
      <button type="button" className="danger-solid" disabled={o.busy || !o.ready} onClick={o.confirm}>
        {o.label}
      </button>
    </EditorFooter>
  );
}

/**
 * “库存怎么处理”：选项文字按删的对象说（删单据说“这张单子”，删档案说“连带删掉的单据”“只删记录”），
 * 和助手确认卡片同一份（shared/business/deletion-words.ts），换选项重新查询时也不变
 */
function InventoryChoice(o: {
  module: DeletionModule;
  policy: InventoryPolicy;
  hint: string | undefined;
  busy: boolean;
  change: (policy: InventoryPolicy) => void;
}) {
  const options = inventoryOptions(o.module);
  return (
    <FormSection columns={1}>
      <FormField label="库存怎么处理" hint={o.hint}>
        <select
          aria-label="库存怎么处理"
          value={o.policy}
          disabled={o.busy}
          onChange={(e) => o.change(e.target.value === 'preserve' ? 'preserve' : 'recalculate')}
        >
          {/* 选项文字按删的对象说：删单据说“这张单子”，删档案说“连带删掉的单据”“只删记录” */}
          <option value="recalculate">{options.recalculate}</option>
          <option value="preserve">{options.preserve}</option>
        </select>
      </FormField>
    </FormSection>
  );
}

/** 查到的清单，库存怎么变的那句，要输密码时的密码框 */
function PlanBody(o: { plan: Preview; choice: number; needsPassword: boolean; password: string; setPassword: (v: string) => void }) {
  return (
    <>
      <DeletionImpact plan={o.plan} />
      {/* 不用选库存怎么处理时，库存怎么变的那句直接写在清单下面（要选时它是选项的说明） */}
      {o.choice === 0 && o.plan.inventoryEffect && <p className="sales-muted">{o.plan.inventoryEffect}</p>}
      {/* 密码框不自动聚焦：清单长时聚焦会把窗口滚到最底下，人看不到顶上的提醒和汇总 */}
      {o.needsPassword && (
        <FormSection columns={1}>
          <PasswordField label="输入本人密码确认删除" value={o.password} onChange={o.setPassword} autoComplete="current-password" />
        </FormSection>
      )}
    </>
  );
}

/** 标题下面写要删的是哪几条：最多列三个单号或名称，多的写一共几条 */
function subtitleOf(rows: DeletableRow[]) {
  const names = rows.map((r) => r.number || r.name).filter(Boolean);
  return names.length ? names.slice(0, 3).join('、') + (names.length > 3 ? ' 等 ' + names.length + ' 条' : '') : undefined;
}

/** 删完怎么说：删了谁、连带删了几条（口径和清单“会删除 N”一致，只数用户认识的记录），库存怎么处理的 */
const doneMessage = (o: { module: DeletionModule; rows: DeletableRow[]; impact: Preview['impact']; choice: number; policy: InventoryPolicy }) =>
  deletionDoneMessage(o.module, o.rows, o.impact) +
  (o.choice > 0 ? (o.policy === 'recalculate' ? '，库存已改回' : '，库存数量没动') : '') +
  '。';

export default function DatabaseDeleteDialog({
  module,
  rows,
  close,
  done,
}: {
  module: DeletionModule;
  rows: DeletableRow[];
  close: () => void;
  done: (message: string) => void;
}) {
  const [policy, setPolicy] = useState<InventoryPolicy>('recalculate'),
    [notice, setNotice] = useState(''),
    [password, setPassword] = useState('');
  const preview = useDeletionPreview(module, rows, policy),
    { plan, choice } = preview;
  const requestId = useRef(crypto.randomUUID());
  // 不在本机（服务器上从域名访问）删已确认的单据：再输一次本人密码。还没核对的单据不用。
  const auth = useAuthState(),
    needsPassword = !auth?.actor?.localAdministrator && !rows.every((r) => r.status === 'draft');
  async function execute(p: Preview) {
    preview.setBusy(true);
    preview.setError('');
    setNotice('');
    try {
      const outcome = await deleteOrRepreview(
        () =>
          executeDeletion({
            module,
            items: items(rows),
            inventoryPolicy: policy,
            requestId: requestId.current,
            deletionDigest: p.digest,
            ...(needsPassword ? { password } : {}),
          }),
        () => {
          // 按最新的清单再删是另一次请求
          requestId.current = crypto.randomUUID();
          return preview.repreview();
        },
      );
      if (!('done' in outcome)) {
        setNotice(outcome.notice);
        return;
      }
      // 先让页面关掉这条记录的详情（同步提交），再通知各处刷新：
      // 否则还开着的详情会去重读已删掉的记录，出现“业务记录不存在”和 404
      flushSync(() => done(doneMessage({ module, rows, impact: outcome.done.impact, choice, policy })));
      emit('erp-business-changed');
    } catch (e) {
      // 失败后换一个请求编号：改了选项再点，不会被当成同一次请求
      requestId.current = crypto.randomUUID();
      preview.setError(errorMessage(e));
      preview.setBusy(false);
    }
  }
  // 标题和主按钮写明连带删掉几张什么单据
  const headline = plan ? deletionHeadline(module, rows, plan.impact) : null;
  return (
    <ManagementDialog
      title={headline?.title || '删除'}
      subtitle={subtitleOf(rows)}
      size="md"
      close={close}
      busy={preview.busy}
      danger
      footer={
        <DeleteFooter
          busy={preview.busy}
          ready={!!plan && !(needsPassword && !password)}
          alarming={!!headline?.alarming}
          label={preview.busy && plan ? '正在删除…' : headline?.title || '确认删除'}
          close={close}
          confirm={() => plan && void execute(plan)}
        />
      }
    >
      <FormMessage>{preview.error}</FormMessage>
      <FormMessage tone="warning">{notice}</FormMessage>
      <FormMessage tone="warning">删除后不能恢复。请核对下面会一起处理的记录，再点下面的删除按钮。</FormMessage>
      {choice > 0 && (
        <InventoryChoice
          module={module}
          policy={policy}
          hint={plan?.inventoryEffect}
          busy={preview.busy}
          change={(next) => {
            requestId.current = crypto.randomUUID();
            setPolicy(next);
          }}
        />
      )}
      {!plan && !preview.error && (
        <p className="sales-muted" role="status">
          正在查询会一起处理的记录…
        </p>
      )}
      {plan && (
        <PlanBody plan={plan} choice={choice} needsPassword={needsPassword} password={password} setPassword={setPassword} />
      )}
    </ManagementDialog>
  );
}

import { useRef, useState } from 'react';
import type { PurchaseView } from '../../shared/business/index';
import { emit, FormMessage, ManagementDialog, notify, Segmented, useLoad, Loading } from '../ui/index';
import { PurchaseEditor } from './PurchaseEditor';
import { readManyLaunch, readSingleLaunch } from './purchase-launch-data';
import { savePurchase, type PurchaseBody } from './purchase-api';

/** 几张订单时：合成一张采购单，还是每张订单一张 */
const modeOptions = [
  ['one', '合成一张采购单'],
  ['each', '每张订单一张'],
] as const;
type Mode = (typeof modeOptions)[number][0];
/** 按订单拆开保存时已经建好的（按订单）：保存时的内容和建好的采购单 */
type Created = Record<string, { sig: string; result: PurchaseView } | undefined>;

/**
 * “安排订料”（全站只有这一个窗口）：打开新建采购单，预先关联订单，每张订单的每种要生产的产品一行纸板，
 * 只带出材质和楞型；尺寸、张数、单价不推算。
 * - 一张订单（订单详情、订单的下一步、采购单页的链接）：同一产品上次订过的纸板规格标成“参考上次”；
 *   productIds 给了就只排这几种产品。
 * - 几张订单（订单列表多选）：窗口最上面切换“合成一张采购单”（系统里按订单分行，导出的订货单上同种纸板合成一行）
 *   还是“每张订单一张”（保存时按订单拆开，之后在采购单列表勾选它们导出一份订货单给供应商）。
 * 办完：给了 done 就交给调用方提示；没给就在页面底部提示、关窗口。
 */
export default function PurchaseLaunch({
  orderIds,
  productIds = [],
  close,
  done,
}: {
  orderIds: number[];
  productIds?: number[];
  close: () => void;
  done?: (message: string) => void;
}) {
  const single = orderIds.length === 1;
  const loaded = useLoad(orderIds.join(',') + '|' + productIds.join(','), () =>
    single ? readSingleLaunch(orderIds[0], productIds) : readManyLaunch(orderIds),
  );
  const state = loaded.loading ? null : loaded.data;
  const [mode, setMode] = useState<Mode>('one');
  // 按订单拆开保存时，已经建好的不再重复建
  const created = useRef<Created>({});
  if (!state)
    return (
      <ManagementDialog title="安排订料" size="sm" close={close}>
        {loaded.error ? (
          <FormMessage>{loaded.error}</FormMessage>
        ) : (
          <Loading what="订单、产品和供应商" />
        )}
      </ManagementDialog>
    );
  const finish = (message: string) => {
    emit('erp-business-changed');
    if (done) return done(message);
    notify(message);
    close();
  };
  return (
    <PurchaseEditor
      initialValues={state.seed}
      suppliers={state.suppliers}
      orders={state.orders}
      items={state.items}
      close={close}
      banner={single ? undefined : <ModeSwitch mode={mode} setMode={setMode} />}
      saveLabel={mode === 'each' ? '按订单保存采购单' : '保存采购单'}
      submit={
        mode === 'each'
          ? async (body) => {
              const results = await saveEach(body, created.current);
              finish(
                '已按订单建了 ' +
                  results.length +
                  ' 张采购单：' +
                  results.map((r) => r.number).join('、') +
                  '。在采购单列表勾选它们，点“导出订货单”合成一份发给供应商。',
              );
            }
          : undefined
      }
      saved={(result) => finish('采购单 ' + (result.number || '') + ' 已保存，关联订单 ' + state.numbers + '。')}
    />
  );
}

/** 几张订单时：合成一张采购单，还是每张订单一张 */
function ModeSwitch({ mode, setMode }: { mode: Mode; setMode: (mode: Mode) => void }) {
  return (
    <div className="pur-mode">
      <Segmented
        tabs
        label="采购单怎么建"
        value={mode}
        onChange={(v) => {
          const picked = modeOptions.find(([key]) => key === v);
          if (picked) setMode(picked[0]);
        }}
        options={modeOptions}
      />
      <small>
        {mode === 'one'
          ? '系统里按订单分行，每行记着给哪张订单；导出的订货单上同种纸板合成一行。'
          : '保存时按订单拆成几张采购单；之后在采购单列表勾选它们，导出一份订货单给供应商。'}
      </small>
    </div>
  );
}

/**
 * 每张订单一张：按每行关联的订单拆开保存，没关联订单的行单独一张。
 * created 记着已经建好的（按订单）：内容没变的不再重复建；建好以后又改了的，请人到采购单里改。
 */
async function saveEach(body: PurchaseBody, created: Created) {
  const groups = new Map<string, PurchaseBody['lines']>();
  for (const l of body.lines) {
    const k = String(l.customerOrderId ?? '');
    groups.set(k, [...(groups.get(k) || []), l]);
  }
  const results: PurchaseView[] = [];
  for (const [k, lines] of groups) {
    const sig = JSON.stringify({ ...body, lines });
    const done = created[k];
    if (done?.sig === sig) {
      results.push(done.result);
      continue;
    }
    if (done) throw new Error('采购单 ' + done.result.number + ' 已经建好，请关掉这个窗口到采购单里修改。');
    const result = await savePurchase({ ...body, customerOrderId: k ? Number(k) : null, lines });
    created[k] = { sig, result };
    results.push(result);
  }
  return results;
}

import { useState } from 'react';
import type { FlowDocView } from '../../shared/business/index';
import { FormMessage, ManagementDialog, useLoad } from '../ui/index';
import ArrivalCorrection from './ArrivalCorrection';
import DeliveryCorrection from './DeliveryCorrection';
import ProductionCorrection from './ProductionCorrection';
import { readFlow } from './flow-api';
import { correctLabel, type CorrectableKind } from './flow-words';
import type { CorrectionResult } from './useCorrection';

/**
 * 更正已生效的到货、送货、完工单：改数量这类只有这一条路，提交后撤销原单、另出一张更正后的单据，库存按净变化调整。
 * 单据页、仓库页、数据管理、AI 导入、采购单的到货记录都打开这一个窗口；打开时按 id 读这张单据最新的内容。
 * 办完关窗，done 拿到服务端的结果（summary 是给页面提示的一句话）。
 */
export default function CorrectionDialog({
  id,
  kind,
  close,
  done,
}: {
  id: number;
  kind: CorrectableKind;
  close: () => void;
  done: (result: CorrectionResult) => void;
}) {
  const loaded = useLoad('flow:' + id, () => readFlow(id));
  // 核验、提交被拒（别人刚改过这张单）以后读回的最新内容
  const [latest, setLatest] = useState<FlowDocView | null>(null);
  const doc = latest || loaded.data,
    error = loaded.error;
  const refresh = async () => {
    const fresh = await readFlow(id);
    setLatest(fresh);
    return fresh;
  };
  if (!doc)
    return (
      <ManagementDialog title={correctLabel(kind)} size="lg" close={close}>
        {error ? <FormMessage>{error}</FormMessage> : <p role="status">正在读取单据…</p>}
      </ManagementDialog>
    );
  // 各种单据的更正内容：拿到最新的单据，自己管“改成多少”那几栏，外壳用 CorrectionShell
  const part = { close, done, refresh };
  switch (doc.kind) {
    case 'arrival':
      return <ArrivalCorrection doc={doc} {...part} />;
    case 'delivery':
      return <DeliveryCorrection doc={doc} {...part} />;
    case 'production':
      return <ProductionCorrection doc={doc} {...part} />;
    case 'task':
      // 只有到货、送货、完工单能更正，打开这个窗口的地方都按种类挡过
      throw new Error('生产任务不能更正。');
  }
}

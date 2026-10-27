import type { ImportWorkspaceView as Workspace } from '../../shared/order-draft';
import DraftChat from './DraftChat';
export default function OrderChat({
  workspace,
  locked,
  unsaved,
  send,
}: {
  workspace?: Workspace;
  locked: boolean;
  unsaved: boolean;
  send: (s: string) => Promise<unknown>;
}) {
  return (
    <DraftChat
      identity={workspace?.id}
      ready={!!workspace?.draft}
      messages={workspace?.messages || []}
      title="订单助手"
      emptyText="识别订单后，可核对交期、检查金额或直接修改草稿。"
      placeholder="例如：第二个产品数量改成500"
      locked={locked}
      unsaved={unsaved}
      send={send}
    />
  );
}

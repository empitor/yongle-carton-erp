import { useState } from 'react';
import { EditorFooter, FormField, FormMessage, ManagementDialog } from '../ui/index';

/** 收件箱“粘贴文字”：把客户发来的文字加进收件箱。加好了由页面关窗、提示。 */
export default function InboxPasteDialog({
  busy,
  error,
  close,
  add,
}: {
  busy: boolean;
  error: string;
  close: () => void;
  add: (text: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <ManagementDialog
      title="粘贴文字"
      size="md"
      busy={busy}
      close={close}
      footer={
        <EditorFooter note="加进来后在“待处理”里转订单或标为已处理。">
          <button className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={!text.trim() || busy} onClick={() => add(text.trim())}>
            {busy ? '正在加入…' : '加入收件箱'}
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error}</FormMessage>
      <FormField label="内容" required>
        <textarea
          autoFocus
          rows={10}
          aria-label="粘贴的内容"
          placeholder="把客户发来的文字粘贴到这里"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </FormField>
    </ManagementDialog>
  );
}

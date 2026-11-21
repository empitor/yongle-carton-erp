import { useRef, useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import { canEditBusiness, useAuthState, notify, LIST_PAGE_SIZE, stepper, useAction, emit, FormMessage } from '../ui/index';
import { DetailPanel } from '../ui/index';
import { PageHeading, Pagination } from '../ui/index';
import InboxDetail, { inboxKicker, inboxSubtitle, InboxStatus } from './InboxDetail';
import InboxTable from './InboxTable';
import InboxRowActions from './InboxRowActions';
import InboxPasteDialog from './InboxPasteDialog';
import { ChannelNote, InboxFilters } from './InboxFilters';
import type { ConvertedKind, InboxItem, InboxStatus as Status } from '../../shared/import/index';
import { addInboxText, convertInboxItem, setInboxStatus, uploadInboxFiles } from './inbox-api';
import { useInboxList } from './useInboxList';

/** 收件箱：发给机器人的、手动上传和粘贴的内容；点行看详情，在详情里转订单、转到货或标记处理。 */
export default function InboxPage() {
  const auth = useAuthState(),
    canEdit = canEditBusiness(auth);
  const list = useInboxList(),
    { data, rows, selected, setSelected } = list;
  const [pasting, setPasting] = useState(false);
  const { busy, error: workError, run, clear } = useAction();
  const input = useRef<HTMLInputElement>(null);
  const error = list.error || workError;

  /** 业务数据变了：列表跟着重读，导航角标、今日页也重新数 */
  const changed = () => emit('erp-business-changed');
  const convert = (row: InboxItem, kind: ConvertedKind) =>
    run(async () => {
      const result = await convertInboxItem(row, kind);
      changed();
      location.hash = '#ai-import?workspace=' + result.workspaceId;
    });
  /** 改处理状态：办完在页面底部提示一句。 */
  const setRowStatus = (row: InboxItem, next: Status, message: string) =>
    void run(async () => {
      await setInboxStatus(row, next);
      changed();
      notify(message);
    });
  const addText = (text: string) =>
    run(async () => {
      await addInboxText(text);
      setPasting(false);
      list.setStatus('pending');
      changed();
      notify('文字已加入收件箱。');
    });
  const addFiles = (files: File[]) =>
    run(async () => {
      await uploadInboxFiles(files);
      list.setStatus('pending');
      changed();
      if (files.length) notify('已上传 ' + files.length + ' 个文件到收件箱。');
    });

  return (
    <div className="inbox-page">
      <PageHeading
        title="收件箱"
        secondary={{ label: '粘贴文字', icon: <Plus size={15} />, disabled: !canEdit, onClick: () => setPasting(true) }}
        primary={{
          label: '上传文件',
          icon: <Upload size={15} />,
          disabled: !canEdit,
          onClick: () => input.current?.click(),
        }}
      >
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="上传到收件箱"
          onChange={(e) => {
            void addFiles(Array.from(e.target.files || []));
            e.target.value = '';
          }}
        />
      </PageHeading>
      <InboxFilters list={list} />
      <ChannelNote channels={list.channels} isAdmin={auth?.actor?.role === 'super_admin'} />
      <FormMessage
        close={() => {
          list.clearError();
          clear();
        }}
      >
        {error}
      </FormMessage>
      <section className="panel business-records">
        <InboxTable rows={rows} loaded={!!data} status={list.filter.status} selectedId={selected?.id} select={setSelected} />
        <Pagination
          page={data?.page ?? 1}
          total={data?.filteredRecords ?? 0}
          pageSize={LIST_PAGE_SIZE}
          onChange={list.setPage}
        />
      </section>
      {selected && (
        <DetailPanel
          kicker={inboxKicker(selected)}
          title={selected.fileName || selected.senderName || '文字消息'}
          status={<InboxStatus row={selected} />}
          subtitle={inboxSubtitle(selected)}
          actions={
            <InboxRowActions
              row={selected}
              canEdit={canEdit}
              busy={busy}
              convert={(row, kind) => void convert(row, kind)}
              setRowStatus={setRowStatus}
            />
          }
          close={() => {
            setSelected(null);
            if (list.linked) history.replaceState(null, '', '#inbox');
          }}
          {...stepper(rows, (r) => r.id, selected?.id, setSelected)}
        >
          <InboxDetail row={selected} />
        </DetailPanel>
      )}
      {pasting && (
        <InboxPasteDialog busy={busy} error={workError} close={() => setPasting(false)} add={(text) => void addText(text)} />
      )}
    </div>
  );
}

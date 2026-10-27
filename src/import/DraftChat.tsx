import { useState, useEffect, useRef } from 'react';
import { Send, MessageSquare } from 'lucide-react';
export default function DraftChat({
  identity,
  ready,
  messages,
  title,
  emptyText,
  placeholder,
  locked,
  unsaved,
  send,
  lockedLabel = '处理中',
}: {
  identity?: string;
  ready: boolean;
  messages: { role: string; text: string; at?: string }[];
  title: string;
  emptyText: string;
  placeholder: string;
  locked: boolean;
  unsaved: boolean;
  send: (s: string) => Promise<unknown>;
  lockedLabel?: string;
}) {
  const [message, setMessage] = useState(''),
    log = useRef<HTMLDivElement>(null);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  useEffect(() => {
    setMessage('');
  }, [identity]);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [identity, messages.length]);
  return (
    <section className="oi-chat">
      <header>
        <strong>
          <MessageSquare size={15} />
          {title}
        </strong>
        <small>{identity ? '仅作用于当前文件' : '请选择文件'}</small>
      </header>
      <div
        className="oi-chat-log"
        ref={log}
        aria-label={title === '订单助手' ? '当前订单聊天记录' : '当前到货单聊天记录'}
      >
        {messages.map((m, i) => (
          <div key={i} className={'oi-chat-message ' + m.role}>
            <small>{m.role === 'user' ? '你' : title}</small>
            <p>{m.text}</p>
          </div>
        ))}
        {!ready && <div className="oi-chat-empty">{emptyText}</div>}
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!message.trim()) return;
          const old = message;
          const owner = identity;
          setMessage('');
          if (!(await send(old)) && identityRef.current === owner) setMessage(old);
        }}
      >
        <textarea
          rows={2}
          aria-label={'给' + title + '的消息'}
          disabled={!ready || locked || unsaved}
          placeholder={unsaved ? '请先保存手工修改，再发送消息' : placeholder}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button
          className="primary"
          aria-label="发送聊天消息"
          disabled={!message.trim() || !ready || locked || unsaved}
        >
          <Send size={15} />
          {locked ? lockedLabel : '发送'}
        </button>
      </form>
    </section>
  );
}

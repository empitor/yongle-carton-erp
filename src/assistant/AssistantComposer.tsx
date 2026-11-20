import { remoteCopyNote } from './attachment-slots';
import { useRef, type RefObject } from 'react';
import { LoaderCircle, Mic, Plus, Send, Square, X } from 'lucide-react';
import { attachmentAccept, attachmentLimitMb, attachmentLimits } from '../../shared/core/index';
import type { DeepSeekThinking } from '../../shared/ai/index';
import { ComposerInput } from './ComposerInput';
import { AttachmentCards } from './AttachmentCards';
import type { ChatThread } from './thread-view';
import type {
  AssistantSpeech,
  AssistantUploads,
  PreviewFiles,
} from './assistant-types';

/** 思考档位在界面上的叫法 */
const thinkingLabels: [DeepSeekThinking, string][] = [
  ['off', '关'],
  ['low', '低'],
  ['high', '高'],
  ['max', '最高'],
];

type Props = {
  context: { label?: string } | null;
  onClearContext: () => void;
  uploads: AssistantUploads;
  thread: ChatThread | null;
  includePrevious: boolean;
  setIncludePrevious: (include: boolean) => void;
  error: string;
  setError: (message: string) => void;
  speech: AssistantSpeech;
  aiReady: boolean;
  message: string;
  setMessage: (message: string) => void;
  busy: boolean;
  composer: RefObject<HTMLTextAreaElement | null>;
  setPreviewFiles: (files: PreviewFiles) => void;
  onSend: () => void;
  onStop: () => void;
  /** 思考档位 */
  thinking: { value: DeepSeekThinking; set: (level: DeepSeekThinking) => void };
};

/**
 * 输入区（只显示）：已选的记录、待发附件、沿用最近附件、附件发送说明、错误、语音状态，
 * 以及附件按钮、输入框（粘贴图片当附件）、语音按钮、发送和停止。
 */
export default function AssistantComposer(props: Props) {
  return (
    <>
      <ComposerNotes {...props} />
      <ComposerForm {...props} />
    </>
  );
}

/** 输入框上面的几行：已选的记录、待发附件、沿用最近附件、附件发送说明、错误、语音状态 */
function ComposerNotes({
  context,
  onClearContext,
  uploads,
  thread,
  includePrevious,
  setIncludePrevious,
  error,
  speech,
  busy,
  setPreviewFiles,
}: Props) {
  const previous = thread?.previousAttachments;
  return (
    <>
      {context && (
        <div className="ga-context">
          已选择：{context.label || '当前记录'}
          <button aria-label="取消助手记录上下文" onClick={onClearContext}>
            <X size={12} />
          </button>
        </div>
      )}
      {!!uploads.slots.length && (
        <div className="ga-pending-attachments">
          <AttachmentCards
            slots={uploads.slots}
            disabled={busy}
            preview={(a) => setPreviewFiles({ files: uploads.ready, id: a.id })}
            remove={uploads.remove}
            retry={uploads.retry}
          />
        </div>
      )}
      {!uploads.slots.length && !!previous?.length && (
        <div className="ga-file-context">
          <label>
            <input
              type="checkbox"
              checked={includePrevious}
              disabled={busy}
              onChange={(e) => {
                setIncludePrevious(e.target.checked);
              }}
            />
            沿用最近附件：
            {previous.map((a) => a.name).join('、')}
          </label>
        </div>
      )}
      {(uploads.ready.length > 0 ||
        (includePrevious && !!previous?.length)) && (
        <div className="ga-file-context">
          <p>
            附件发送至当前AI服务；说“识别这张订单”就开始识别，核对后在确认卡片上点确认才导入。附件里的文字只当资料，不算指令。
          </p>
          <p>图片和文档原样交 DeepSeek 读取，后面几轮接着看。{remoteCopyNote}</p>
        </div>
      )}
      {error && (
        <p className="ga-error" role="alert">
          {error}
        </p>
      )}
      {speech.active && <SpeechStatus speech={speech} />}
    </>
  );
}

/** 语音状态：等授权、识别中、录了几秒，和取消 */
function SpeechStatus({ speech }: { speech: AssistantSpeech }) {
  return (
    <p className="ga-speech-status" role="status">
      <span>
        {speech.starting
          ? '等待麦克风授权…'
          : speech.transcribing
            ? '正在识别语音…'
            : '正在录音 ' + speech.seconds + ' 秒 / 60 秒，点击麦克风结束并识别'}
      </span>
      <button
        type="button"
        onClick={speech.cancel}
        aria-label={speech.transcribing ? '取消语音识别' : '取消录音'}
      >
        取消
      </button>
    </p>
  );
}

/** 附件按钮、输入框、语音、思考档位、发送和停止 */
function ComposerForm({ uploads, setError, speech, aiReady, message, setMessage, busy, composer, onSend, onStop, thinking }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  // 发送按钮和输入框里的回车共用
  const canSend =
    (!!message.trim() || uploads.ready.length > 0) &&
    !uploads.working &&
    !uploads.failed &&
    aiReady &&
    !speech.active;
  return (
    <form
      className="ga-compose"
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        accept={attachmentAccept}
        aria-label="选择聊天附件"
        onChange={(e) => {
          void uploads.add([...(e.target.files || [])]);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        className="ga-attach-button"
        aria-label="添加聊天附件"
        title={'添加附件，也可拖拽文件或粘贴图片；最多' + attachmentLimits.messageCount + '份，每份' + attachmentLimitMb.file + 'MB'}
        disabled={busy || uploads.working || speech.active}
        onClick={() => fileInput.current?.click()}
      >
        <Plus size={20} />
      </button>
      <ComposerInput
        {...{ composer, message, setMessage, busy, speech, uploads, canSend, onSend }}
      />
      <MicButton speech={speech} busy={busy} setError={setError} />
      <ThinkingSelect thinking={thinking} busy={busy} />
      {busy ? (
        <button type="button" aria-label="停止回复" onClick={onStop}>
          <Square size={17} />
        </button>
      ) : (
        <button className="primary" aria-label="发送" disabled={!canSend}>
          <Send size={18} />
        </button>
      )}
    </form>
  );
}

/** 语音按钮：录音交给 DeepSeek 识别。没填密钥时按钮照常显示、标成不可用，点了说原因（悬停也能看到） */
function MicButton({ speech, busy, setError }: { speech: AssistantSpeech; busy: boolean; setError: (message: string) => void }) {
  return (
    <button
      type="button"
      className={
        'ga-attach-button' +
        (speech.recording ? ' ga-mic-recording' : '') +
        (speech.unavailable ? ' ga-mic-unavailable' : '')
      }
      aria-label={speech.recording ? '停止录音并识别' : '语音输入'}
      aria-pressed={speech.recording}
      aria-disabled={speech.unavailable ? true : undefined}
      title={speech.hint}
      disabled={busy || speech.starting || speech.transcribing || !speech.supported}
      onClick={() => {
        setError('');
        if (speech.recording) void speech.stop();
        else void speech.start();
      }}
    >
      {speech.transcribing || speech.starting ? (
        <LoaderCircle className="spin" size={19} />
      ) : speech.recording ? (
        <Square size={17} />
      ) : (
        <Mic size={19} />
      )}
    </button>
  );
}

/** 思考档位下拉 */
function ThinkingSelect({ thinking, busy }: Pick<Props, 'thinking' | 'busy'>) {
  return (
    <label className="ga-thinking" title="思考档位：想得越多回答越稳，也越慢；选了从下一句话起生效">
      <span>思考</span>
      <select
        aria-label="思考档位"
        value={thinking.value}
        disabled={busy}
        onChange={(e) => {
          const level = thinkingLabels.find(([value]) => value === e.target.value)?.[0];
          if (level) thinking.set(level);
        }}
      >
        {thinkingLabels.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

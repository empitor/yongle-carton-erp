import { useMemo, useState, type DragEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { today } from '../../shared/core/index';
import { planDate, shiftDate } from '../../shared/business/index';
import { flowStatusText, type FlowDocView } from '../../shared/business/index';

const weekNames = ['一', '二', '三', '四', '五', '六', '日'];
type Task = FlowDocView<'task'>;
/** 排产板上列的：没归档、待下达或已下达的生产任务（传进来的单据列表按种类认出任务） */
const liveTask = (t: FlowDocView): t is Task => t.kind === 'task' && !t.archived && ['draft', 'confirmed'].includes(t.status);
function mondayOf(date: string) {
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  return shiftDate(date, -((day + 6) % 7));
}

/** 排产板：按周看任务，拖到某天即改计划日期。只调整计划，不影响库存和实际记录。 */
export default function ProductionBoard({
  tasks,
  products,
  canEdit,
  open,
  reschedule,
}: {
  /** 生产任务（单据列表里种类是任务的那些） */
  tasks: readonly FlowDocView[];
  products: readonly { id: number; name: string }[];
  canEdit: boolean;
  open: (task: Task) => void;
  reschedule: (task: Task, date: string) => void;
}) {
  const current = today();
  const [start, setStart] = useState(() => mondayOf(current)),
    [dragging, setDragging] = useState<number | null>(null),
    [over, setOver] = useState<string | null>(null);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => shiftDate(start, i)), [start]);
  const live = tasks.filter(liveTask);
  const unfinished = (t: Task) => t.progress < 100;
  const late = live.filter((t) => unfinished(t) && planDate(t) < start);
  const productName = (id: number) =>
    products.find((p) => p.id === id)?.name || '产品 ' + id;
  const movable = (t: Task) => canEdit && unfinished(t);
  const card = (t: Task) => (
    <button
      key={t.id}
      className={'board-card' + (t.progress >= 100 ? ' done' : '')}
      draggable={movable(t)}
      onDragStart={(e) => {
        setDragging(t.id);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(t.id));
      }}
      onDragEnd={() => {
        setDragging(null);
        setOver(null);
      }}
      onClick={() => open(t)}
      title={t.number + ' · ' + flowStatusText(t)}
    >
      <strong>{productName(t.productId)}</strong>
      <small className="board-card-number">{t.number}</small>
      <span className="board-progress" aria-label={'完工 ' + t.progress + '%'}>
        <i style={{ width: t.progress + '%' }} />
      </span>
      <small>
        {t.completed} / {t.quantity} {t.unit} · {flowStatusText(t)}
      </small>
    </button>
  );
  const dropProps = (date: string) => ({
    onDragOver: (e: DragEvent) => {
      if (dragging === null) return;
      e.preventDefault();
      setOver(date);
    },
    onDragLeave: () => setOver((v) => (v === date ? null : v)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const task = live.find((t) => t.id === Number(e.dataTransfer.getData('text/plain')));
      setOver(null);
      setDragging(null);
      if (task && planDate(task) !== date) reschedule(task, date);
    },
  });
  return (
    <section className="production-board" aria-label="排产板">
      <div className="board-toolbar">
        <button aria-label="上一周" onClick={() => setStart(shiftDate(start, -7))}>
          <ChevronLeft size={16} />
        </button>
        <strong>
          {days[0].slice(5)} – {days[6].slice(5)}
        </strong>
        <button aria-label="下一周" onClick={() => setStart(shiftDate(start, 7))}>
          <ChevronRight size={16} />
        </button>
        <button onClick={() => setStart(mondayOf(current))}>本周</button>
        <span>拖动任务到某一天即可改期</span>
      </div>
      <div className="board-columns">
        <div className="board-column late">
          <header>
            <b>逾期未完工</b>
            <span>{late.length}</span>
          </header>
          <div className="board-cards">{late.map(card)}</div>
        </div>
        {days.map((date, index) => {
          const list = live.filter((t) => planDate(t) === date);
          return (
            <div
              key={date}
              className={
                'board-column' + (date === current ? ' today' : '') + (over === date ? ' over' : '')
              }
              {...dropProps(date)}
            >
              <header>
                <b>周{weekNames[index]}</b>
                <small>{date.slice(5)}</small>
                <span>{list.length}</span>
              </header>
              <div className="board-cards">{list.map(card)}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

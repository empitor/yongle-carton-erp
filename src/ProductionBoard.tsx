import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { today } from '../shared/domain';
import { planDate, shiftDate } from '../shared/schedule';
import { flowStatusLabel } from '../shared/physical-flow';

const weekNames = ['一', '二', '三', '四', '五', '六', '日'];
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
  tasks: any[];
  products: any[];
  canEdit: boolean;
  open: (task: any) => void;
  reschedule: (task: any, date: string) => void;
}) {
  const current = today();
  const [start, setStart] = useState(() => mondayOf(current)),
    [dragging, setDragging] = useState<number | null>(null),
    [over, setOver] = useState<string | null>(null);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => shiftDate(start, i)), [start]);
  const live = tasks.filter(
    (t) => !t.archived && ['draft', 'confirmed'].includes(t.status),
  );
  const unfinished = (t: any) => t.progress < 100;
  const late = live.filter((t) => unfinished(t) && planDate(t) < start);
  const productName = (id: number) =>
    products.find((p) => p.id === id)?.name || '产品 ' + id;
  const movable = (t: any) => canEdit && unfinished(t);
  const card = (t: any) => (
    <button
      key={t.id}
      className={'board-card' + (t.status === 'draft' ? ' draft' : '') + (t.progress >= 100 ? ' done' : '')}
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
      title={t.number + ' · ' + flowStatusLabel(t)}
    >
      <strong>{productName(t.productId)}</strong>
      <small>{t.number}</small>
      <span className="board-progress" aria-label={'完工 ' + t.progress + '%'}>
        <i style={{ width: t.progress + '%' }} />
      </span>
      <small>
        {t.completed} / {t.quantity} {t.unit} · {flowStatusLabel(t)}
      </small>
    </button>
  );
  const dropProps = (date: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (dragging === null) return;
      e.preventDefault();
      setOver(date);
    },
    onDragLeave: () => setOver((v) => (v === date ? null : v)),
    onDrop: (e: React.DragEvent) => {
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

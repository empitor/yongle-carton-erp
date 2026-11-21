// 使用说明页：显示使用手册 docs/使用手册.md（GET /api/guide，服务端 server/system/user-manual.ts 按章节切好），
// 助手的 guide.read 读的是同一份。左边章节目录，右边这一节的正文；手机上目录在上面横着排。
import { useEffect, useState } from 'react';
import { errorMessage } from '../../shared/core/index';
import type { UserManual } from '../../shared/system/index';
import { readGuide } from './guide-api';
import { EmptyState, Markdown } from '../ui/index';

export default function GuidePage() {
  const [manual, setManual] = useState<UserManual | null>(null);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    readGuide().then(setManual, (e: unknown) => setError(errorMessage(e) || '请稍后刷新页面再试。'));
  }, []);
  if (error) return <EmptyState title="使用说明没有读出来" description={error} />;
  if (!manual) return null;
  const section = manual.sections[current];
  return (
    <div className="guide-grid">
      <nav className="panel guide-toc" aria-label="使用说明章节">
        <p>{manual.intro}</p>
        {manual.sections.map((s, i) => (
          <button
            key={s.title}
            type="button"
            className={i === current ? 'active' : ''}
            aria-current={i === current ? 'true' : undefined}
            onClick={() => {
              setCurrent(i);
              document.querySelector('.guide-body')?.scrollIntoView({ block: 'start' });
            }}
          >
            {s.title}
          </button>
        ))}
      </nav>
      {section && (
        <article className="panel prose guide-body">
          <h2>{section.title}</h2>
          <Markdown source={section.body} />
        </article>
      )}
    </div>
  );
}

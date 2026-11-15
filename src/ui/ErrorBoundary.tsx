import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportPageProblem } from './problem-report';

/**
 * 页面出错时的兜底：只把出错的这一页换成提示，顶栏、侧栏照常能用，换一页就恢复。
 * 以前没有兜底，一处渲染出错整站白屏、切页也恢复不了，只能刷新。
 * 用法：<ErrorBoundary key={页面}>…</ErrorBoundary>，换页面时 key 变了就重新来。
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('页面出错', error, info.componentStack);
    reportPageProblem({ kind: 'script', message: error.message || '页面出错' });
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="page-error panel" role="alert">
        <h2>这个页面出错了</h2>
        <p>别的页面不受影响。可以重新加载这一页，或者先去别的页面；问题一直出现请把下面这句话告诉管理员。</p>
        <p className="page-error-detail">{this.state.error.message}</p>
        <div className="page-error-actions">
          <button type="button" className="secondary" onClick={() => (location.hash = '#dashboard')}>
            回到今日
          </button>
          <button type="button" className="primary" onClick={() => location.reload()}>
            重新加载
          </button>
        </div>
      </section>
    );
  }
}

import type { ReactNode } from 'react';
import { BrandLogo } from './ui/index';

/* 登录页、强制改密页共用的外框和出错提示。 */

/** 居中的卡片：公司商标和名称、这一步的标题和一句说明 */
export function LoginCard({ title, subtitle, children }: { title?: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="login-screen" data-agent-private>
      <section className="login-card">
        <header className="login-head">
          <BrandLogo size={56} />
          <h1>宁波甬勒包装制品有限公司</h1>
          {title && <h2>{title}</h2>}
          <p>{subtitle}</p>
        </header>
        {children}
      </section>
    </main>
  );
}

export function LoginAlert({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="form-alert" role="alert">
      {text}
    </p>
  );
}

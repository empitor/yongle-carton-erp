import type { FilingRecords } from '../shared/core/index';
import { inShellApp } from './app-bridge';

/*
 * 网页最底部的备案号（登录页和登录后的页脚）。号是服务器的部署设置，登录状态接口只在从域名进来时带出；
 * 两个应用程序（安卓 App、Windows 客户端）里不显示，没填的不显示。
 */

/** ICP 备案号按规定链到工信部备案查询；公安备案号链到公安备案查询，查询码是号里的数字 */
const MIIT_QUERY = 'https://beian.miit.gov.cn/',
  MPS_QUERY = 'https://beian.mps.gov.cn/#/query/webSearch?code=';

type FilingLink = { text: string; href: string };

/** 要显示的备案号和链接；在应用程序里或没填时是空的 */
export function filingLinks(filing: FilingRecords | undefined, host: Parameters<typeof inShellApp>[0]): FilingLink[] {
  if (!filing || inShellApp(host)) return [];
  return [
    ...(filing.icp ? [{ text: filing.icp, href: MIIT_QUERY }] : []),
    ...(filing.police ? [{ text: filing.police, href: MPS_QUERY + filing.police.replace(/\D/g, '') }] : []),
  ];
}

export function FilingLine({ filing }: { filing?: FilingRecords }) {
  const links = filingLinks(filing, window);
  if (!links.length) return null;
  return (
    <p className="filing-line">
      {links.map((link) => (
        <a key={link.href} href={link.href} target="_blank" rel="noreferrer">
          {link.text}
        </a>
      ))}
    </p>
  );
}

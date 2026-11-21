// 使用手册（docs/使用手册.md，随安装包发布，见 scripts/release-files.mjs）只有这一份：
// “使用说明”页走 GET /api/guide（接口表 shared/system/guide-api.ts），助手的 guide.read 也读这里，按二级标题切成章节。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import type { GuideApi, UserManual } from '../../shared/system/index.js';
import { route } from '../core/index.js';

const manualFile = fileURLToPath(new URL('../../docs/使用手册.md', import.meta.url));

/** 一级、二级标题行的开头 */
const TITLE_MARK = '# ',
  SECTION_MARK = '## ';

/** 读手册：一级标题、第一节之前的引言、按 “## ” 切开的各节（三级标题留在节的正文里）。每次现读，改了手册不用重启。 */
export function readUserManual(file = manualFile): UserManual {
  const [head, ...parts] = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split(/\n(?=## )/);
  const lines = head.split('\n');
  const titleLine = lines.findIndex((line) => line.startsWith(TITLE_MARK));
  return {
    title: titleLine >= 0 ? lines[titleLine].slice(TITLE_MARK.length).trim() : '使用手册',
    intro: lines.slice(titleLine + 1).join('\n').trim(),
    sections: parts.map((part) => {
      const [first, ...rest] = part.split('\n');
      return { title: first.slice(SECTION_MARK.length).trim(), body: rest.join('\n').trim() };
    }),
  };
}

/** 按标题里的几个字找一节，找不到返回 null */
export function findManualSection(manual: UserManual, words: string) {
  return manual.sections.find((s) => s.title.includes(words)) ?? null;
}

/** GET /api/guide：整份手册（登录后都能看，出纳也能看，见 shared/core/account-scope.ts） */
export function userManualRouter() {
  const router = Router();
  route<GuideApi>(router, '/guide')('GET /guide', ({ reply }) => {
    reply.cache('no-cache');
    return readUserManual();
  });
  return router;
}

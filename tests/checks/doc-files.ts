// 文档检查（doc-paths、doc-section-refs、docs-structure）共用的文件清单：要扫哪些文档、技能、子智能体定义只在这里写一处。
// 多查一类文件（比如 apps/*/docs）就改这里，三条检查一起跟上。路径一律用 / 分隔、相对项目根目录。
import { readdirSync } from 'node:fs';

/** 目录下所有 .md（含子目录） */
export const markdown = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? markdown(dir + '/' + e.name) : e.name.endsWith('.md') ? [dir + '/' + e.name] : [],
  );

/** 技能目录，写成 `.claude/skills/<名字>/`（AGENTS.md 地图里就这么写） */
export const skillDirs = () =>
  readdirSync('.claude/skills', { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `.claude/skills/${e.name}/`);

/** 子智能体定义 `.claude/agents/<名字>.md` */
export const agentFiles = () =>
  readdirSync('.claude/agents')
    .filter((n) => n.endsWith('.md'))
    .map((n) => `.claude/agents/${n}`);

/** 给模型读的技能（SKILL.md 和 references/ 等）和子智能体定义，和文档一样查路径、指路 */
export const modelFiles = () => [...skillDirs().flatMap((d) => markdown(d.slice(0, -1))), ...agentFiles()];

/** 查路径和指路时扫的全部：docs/ 下的文档、AGENTS.md、技能、子智能体定义 */
export const docFiles = () => [...markdown('docs'), 'AGENTS.md', ...modelFiles()];

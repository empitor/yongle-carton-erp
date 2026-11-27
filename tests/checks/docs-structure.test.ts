// 文档的结构：AGENTS.md 只是目录，读完它就去读具体那份，所以地图和实际文件要一一对应、每份开头写清什么时候读、每份不长。
// 拦：地图（AGENTS.md“做什么读哪份”）漏列或多列了 docs/ 下的文档、.claude/skills/ 下的技能、.claude/agents/ 下的定义；
// docs/ 有第二层子目录、门类之外的文件夹、根目录多出别的文档；文档开头不是“# 标题”加空行加“什么时候读：”；
// 手写的一份超过 5000 字（docs/生成/ 下生成的、使用手册、更新日志不算；已登记超长的只许变短）；文档里写“先读 某文档”
// （只许“相关的见”，要读什么由地图列）；门类文件夹没被 .gitignore 放行（新文档进不了仓库）。
// 字数按字符算，换行一律按 LF 数，和检出方式无关。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { agentFiles, markdown, skillDirs } from './doc-files.js';

/** docs/ 下只许这几个文件夹：六个门类，加商标原图 */
const folders = ['架构', '功能', '界面', '运维', '计划', '生成', 'brand'];
/** docs/ 根目录只许这几份 */
const rootDocs = ['业务规则.md', 'CHANGELOG.md', '使用手册.md'];
/** 开头不写“什么时候读：”的和原因 */
const noWhenToRead: Record<string, string> = {
  'docs/使用手册.md': '给用软件的人看，“使用说明”页和助手读的都是它，开头写给员工',
  'docs/CHANGELOG.md': '发布时整理成发布说明，开头写给看更新的人',
};
const LIMIT = 5000;
/** 已登记超长的实际比登记短出这么多以上，算登记太松：删短了就把登记的字数跟着调低（照首屏体积上限的做法） */
const LOOSE = 0.05;
/** 不算字数的：生成的、给员工的手册、更新日志 */
const notCounted = (file: string) => file.startsWith('docs/生成/') || file in noWhenToRead;
/** 超过 5000 字的手写文档：登记时的字数（只许变短）和原因。压到上限以下或拆开就删掉 */
const overLimit: Record<string, { size: number; why: string }> = {
  'docs/架构/代码检查.md': { size: 5721, why: '全部体检顺序、检查分类、各项检查的上限和命令参数，删了就丢规矩；要压只能把手动比对脚本挪走，待用户定' },
};

const docs = markdown('docs');
const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const length = (file: string) => [...read(file)].length;

/** AGENTS.md“做什么读哪份”一节里反引号写的文档、技能、定义 */
function mapped() {
  const text = read('AGENTS.md');
  const start = text.indexOf('\n## 做什么读哪份\n');
  assert.ok(start >= 0, 'AGENTS.md 里找不到“做什么读哪份”一节');
  const end = text.indexOf('\n## ', start + 1);
  const section = text.slice(start, end < 0 ? undefined : end);
  return new Set(
    [...section.matchAll(/`([^`\s]+)`/g)]
      .map((m) => m[1])
      .filter((p) => !/[<>*]/.test(p))
      .map((p) => p.replace(/\/SKILL\.md$/, '/'))
      .filter((p) => /^docs\/.+\.md$/.test(p) || /^\.claude\/(skills\/[^/]+\/|agents\/[^/]+\.md)$/.test(p)),
  );
}
const existing = () => [...docs, ...skillDirs(), ...agentFiles()];

test('AGENTS.md 地图和 docs/、.claude/skills/、.claude/agents/ 下的实际文件一一对应', () => {
  const map = mapped();
  const files = existing();
  assert.deepEqual(
    [
      ...files.filter((f) => !map.has(f)).map((f) => f + '：有这份，AGENTS.md“做什么读哪份”没列，加一行'),
      ...[...map].filter((f) => !files.includes(f)).map((f) => f + '：地图里列了，文件已经不在，从地图删掉或改成现在的路径'),
    ],
    [],
  );
});

test('docs/ 只有一层门类文件夹，根目录只有业务规则、更新日志、使用手册', () => {
  const problems: string[] = [];
  for (const e of readdirSync('docs', { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!folders.includes(e.name)) problems.push(`docs/${e.name}/：门类只有 ${folders.join('、')}，放进其中一个`);
      for (const sub of readdirSync('docs/' + e.name, { withFileTypes: true }))
        if (sub.isDirectory()) problems.push(`docs/${e.name}/${sub.name}/：docs/ 下不许有第二层文件夹`);
        else if (/^(readme|index)\.md$/i.test(sub.name)) problems.push(`docs/${e.name}/${sub.name}：文件夹里不放目录页，地图在 AGENTS.md`);
    } else if (!rootDocs.includes(e.name))
      problems.push(`docs/${e.name}：根目录只放 ${rootDocs.join('、')}，按门类放进文件夹`);
  }
  assert.deepEqual(problems, []);
});

test('每份文档开头是“# 标题”、空行、“什么时候读：”一句', () => {
  const bad = docs
    .filter((f) => !(f in noWhenToRead))
    .filter((f) => !/^# \S[^\n]*\n\n什么时候读：\S/.test(read(f)))
    .map((f) => f + '：开头写成“# 标题”、空行、“什么时候读：<和 AGENTS.md 地图那一行对得上的一句>”');
  assert.deepEqual(bad, []);
});

test(`手写的每份不超过 ${LIMIT} 字（生成的、使用手册、更新日志不算）`, () => {
  const over = docs
    .filter((f) => !notCounted(f) && !(f in overLimit) && length(f) > LIMIT)
    .map((f) => `${f} 有 ${length(f)} 字，上限 ${LIMIT}：按主题拆成两份（AGENTS.md 地图跟着加一行），或删掉别处已写过的`);
  assert.deepEqual(over, []);
});

test('已登记超长的手写文档不比登记时长，短了也要把登记调低', () => {
  const off = Object.entries(overLimit)
    .filter(([f]) => docs.includes(f))
    .flatMap(([f, e]) => {
      const size = length(f);
      if (size > e.size) return [`${f} 有 ${size} 字，登记时 ${e.size}：超长的只许变短，加内容先删掉别处写过的，或拆成两份`];
      if (size < e.size * (1 - LOOSE)) return [`${f} 有 ${size} 字，比登记的 ${e.size} 短了不少：把 overLimit 里的 size 调低成 ${size}（只许调低）`];
      return [];
    });
  assert.deepEqual(off, []);
});

test('每个门类文件夹里的文档都被 .gitignore 放行（不然新文档进不了仓库）', () => {
  const ignored = folders.filter((d) => d !== 'brand').filter(
    (d) => spawnSync('git', ['check-ignore', '-q', '--no-index', `docs/${d}/放行检查.md`]).status !== 1,
  );
  assert.deepEqual(ignored.map((d) => `docs/${d}/：被 .gitignore 忽略了（或 git 查不了），照 docs/架构/ 那两行加 !docs/${d}/ 和 !docs/${d}/*.md`), []);
});

test('文档里不写“先读 某文档”：只许“相关的见”，要读什么由 AGENTS.md 地图列出', () => {
  const pointer = /先读[^，。；\n]{0,30}?(?:\.md|docs\/|\]\(|技能|须知|文档|SKILL)/g;
  const found = docs.flatMap((f) =>
    read(f)
      .split('\n')
      .flatMap((line, i) => [...line.matchAll(pointer)].map((m) => `${f}:${i + 1} ${m[0]}：改成“相关的见 \`docs/…\`”`)),
  );
  assert.deepEqual(found, []);
});

test('登记表里的例外都还用得上（建了、改了、压下来了就删掉）', () => {
  const stale = [
    ...Object.keys(noWhenToRead).filter((f) => !docs.includes(f)).map((f) => 'noWhenToRead：' + f),
    ...Object.keys(overLimit).filter((f) => !docs.includes(f) || length(f) <= LIMIT).map((f) => 'overLimit：' + f),
  ];
  assert.deepEqual(stale, []);
});

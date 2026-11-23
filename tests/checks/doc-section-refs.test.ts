// 文档里“见 某文档‘某一节’”的指路要对得上：[文字](路径.md)“小节”、`路径.md`“小节”、AGENTS.md“小节”、
// 光写名字的 架构说明“小节”（docs/ 根目录下的各份），指到的那份文档里要真有这个标题或加粗小标题。
// 文档拆分、改标题以后指路最容易过期，doc-paths 只查路径不查小节，所以另查。连写的“甲”“乙”、“甲”的“乙”都要在那份里。
// 查 docs/（含子目录）、AGENTS.md、.claude/子智能体须知.md。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';

/** 指的不是标题、加粗小标题的指路：哪份文档里、指的哪份的哪个名字、为什么。改了、不提了就删掉 */
const notSections: { doc: string; target: string; name: string; why: string }[] = [];

const markdown = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? markdown(dir + '/' + e.name) : e.name.endsWith('.md') ? [dir + '/' + e.name] : [],
  );
const ownDocs = (dir: string) => (existsSync(dir) ? markdown(dir) : []);
const docs = [...markdown('docs'), 'AGENTS.md', '.claude/子智能体须知.md'];
/** 光写文件名（`构建与测试.md`）时去这几处按文件名找；两个外壳各一份同名的，两份都要有这个小节 */
const searchable = [...docs, ...ownDocs('apps/android/docs'), ...ownDocs('apps/desktop/docs')];
/** 光写名字就算指一份文档的：docs/ 根目录下各份（README、CHANGELOG 不算） */
const bare = readdirSync('docs').filter((n) => n.endsWith('.md') && n !== 'README.md' && n !== 'CHANGELOG.md').map((n) => n.slice(0, -3));

const ref = new RegExp(
  '(?:\\[[^\\]\\n]*\\]\\(([^)\\s]+?\\.md)(?:#[^)\\s]*)?\\)|`([^`\\s]+\\.md)`|(AGENTS\\.md)|(' + bare.join('|') + '))' +
    '((?:(?:、|和|的|里的|下的|一节的)?“[^“”\\n]{1,40}”)+)',
  'g',
);

/** 标题、加粗小标题、指路里的名字统一写法：去掉序号、末尾的冒号和括号说明 */
function plain(name: string) {
  let s = name.replace(/`/g, '').trim().replace(/^(?:[一二三四五六七八九十]+、|\d+\.\s*)/, '');
  for (let before = ''; before !== s; ) {
    before = s;
    s = s.replace(/[：:。，、\s]+$/, '').replace(/(?:（[^（）]*）|\([^()]*\))$/, '');
  }
  return s;
}
const sectionCache = new Map<string, Set<string>>();
function sections(file: string) {
  const cached = sectionCache.get(file);
  if (cached) return cached;
  const text = readFileSync(file, 'utf8');
  const names = [...text.matchAll(/^#{1,6} +(\S.*)$/gm), ...text.matchAll(/\*\*([^*\n]+?)\*\*/g)].map((m) => plain(m[1]));
  const set = new Set(names);
  sectionCache.set(file, set);
  return set;
}

/** 指路指到的文档（可能两份）；空数组是找不到这份文档，null 是开发机外没有的文件，不查 */
function targets(doc: string, m: RegExpMatchArray): string[] | null {
  const [, link, quotedPath, agents, name] = m;
  const quoted = quotedPath ?? '';
  if (agents) return ['AGENTS.md'];
  if (name) return ['docs/' + name + '.md'];
  if (link) return [posix.normalize(posix.join(posix.dirname(doc), decodeURI(link)))].filter((f) => existsSync(f));
  if (quoted.startsWith('.claude/')) return existsSync(quoted) ? [quoted] : null;
  const direct = [posix.join(posix.dirname(doc), quoted), quoted].find((f) => existsSync(f));
  return direct ? [direct] : searchable.filter((f) => f.endsWith('/' + quoted));
}

type Found = { at: string; target: string; name: string };
function references(): { found: Found[]; lost: string[] } {
  const found: Found[] = [];
  const lost: string[] = [];
  for (const doc of docs) {
    const text = readFileSync(doc, 'utf8');
    for (const m of text.matchAll(ref)) {
      const at = doc + ':' + text.slice(0, m.index).split('\n').length;
      const files = targets(doc, m);
      if (files === null) continue;
      if (!files.length) lost.push(at + ' ' + m[0] + '：找不到指的那份文档');
      const names = [...(m[5] ?? '').matchAll(/“([^“”]+)”/g)].map((q) => plain(q[1]));
      for (const target of files) for (const name of names) found.push({ at, target, name });
    }
  }
  return { found, lost };
}
const listed = (e: (typeof notSections)[number], f: Found) =>
  f.at.startsWith(e.doc + ':') && e.target === f.target && e.name === f.name;

test('文档里“见 某文档‘某一节’”的指路，那份文档里真有这个标题或加粗小标题', () => {
  const { found, lost } = references();
  const missing = found
    .filter((f) => !sections(f.target).has(f.name) && !notSections.some((e) => listed(e, f)))
    .map((f) => f.at + ' → ' + f.target + '“' + f.name + '”');
  assert.deepEqual([...lost, ...missing], [], '这些指路对不上：改成现在的文档和小节名（拆过的文档看 docs/架构说明.md“别的在哪份”）');
});

test('notSections 名单里的指路还在文档里、指的也确实还不是小节（改了、不提了就删掉）', () => {
  const { found } = references();
  const stale = notSections
    .filter((e) => !found.some((f) => listed(e, f)) || sections(e.target).has(e.name))
    .map((e) => e.doc + ' → ' + e.target + '“' + e.name + '”：从 notSections 删掉');
  assert.deepEqual(stale, []);
});

// 根目录每一项的作用说明（scripts/root-notes.mjs）：发布时按它给 GitHub 文件列表标备注。
// 根目录加了、删了文件或文件夹，清单要跟着改；说明要短到列表里放得下、互不重复。只读清单和根目录，不动 git。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteProblems, rootEntries, rootNotes } from '../scripts/root-notes.mjs';

/** GitHub 文件列表那一栏大约放得下这么多字，后面还要跟版本号 */
const NOTE_MAX = 44;

test('根目录进了仓库的每一项都写了作用，清单里没有多余的', () => {
  assert.deepEqual(noteProblems(rootEntries()), []);
});

test('对不上的会报出来：缺说明的、根目录已经没有的', () => {
  assert.deepEqual(noteProblems(['a', 'b'], { a: '说明', c: '说明' }), [
    'b：根目录有这一项，scripts/root-notes.mjs 里没写它的作用',
    'c：清单里有，根目录已经没有这一项，从 scripts/root-notes.mjs 里删掉',
  ]);
});

test('每条说明不空、不超长、互不重复', () => {
  const notes = Object.values(rootNotes);
  assert.deepEqual(
    Object.entries(rootNotes).filter(([, note]) => !note.trim() || [...note].length > NOTE_MAX).map(([name]) => name),
    [],
  );
  assert.equal(new Set(notes).size, notes.length);
});

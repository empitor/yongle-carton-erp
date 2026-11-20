// 叠在页面上的一层都登记了安卓 App 的返回键（docs/界面规范.md）：src 里渲染 role 为 dialog、alertdialog、menu 的元素
// 或 <dialog> 的组件文件，都要调 src/ui 的 useBackLayer；用 ManagementDialog、DetailPanel 这类已登记的公共件的不自己写 role，不算。
// 两个口子：按文件判断（同一个文件里一层登记了、另一层没登记也算过）；只认字面量 role="…"（role={…} 算出来的、
// 只写了 aria-modal 没写 role 的认不出）。现在没有这样的组件，新写弹层照字面量写 role。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { all, scriptKind } from './module-map.js';

const OVERLAY_ROLES = new Set(['dialog', 'alertdialog', 'menu']);
/** 渲染弹层却不用登记的文件和原因（现在没有） */
const exempt: Record<string, string> = {};

/** 一份组件代码：渲染没渲染弹层、调没调 useBackLayer */
function scan(file: string, text: string) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  let overlay = false,
    registered = false;
  const visit = (n: ts.Node) => {
    if (ts.isJsxAttribute(n) && n.name.getText(source) === 'role' && n.initializer && ts.isStringLiteral(n.initializer))
      overlay ||= OVERLAY_ROLES.has(n.initializer.text);
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(source) === 'dialog') overlay = true;
    if (ts.isCallExpression(n) && n.expression.getText(source) === 'useBackLayer') registered = true;
    ts.forEachChild(n, visit);
  };
  visit(source);
  return { overlay, registered };
}

test('认得出弹层和登记：role 为 menu、dialog 或 <dialog> 算弹层，menuitem 不算', () => {
  assert.deepEqual(scan('a.tsx', 'const A = () => <div role="menu" />;'), { overlay: true, registered: false });
  assert.deepEqual(scan('a.tsx', 'const A = () => <dialog open />;'), { overlay: true, registered: false });
  assert.deepEqual(scan('a.tsx', 'const A = () => { useBackLayer(close); return <section role="dialog" />; };'), {
    overlay: true,
    registered: true,
  });
  assert.deepEqual(scan('a.tsx', 'const A = () => <button role="menuitem" />;'), { overlay: false, registered: false });
});

test('src 里渲染弹层的组件都登记了返回键（不登记的要在例外里写明原因）', () => {
  const missing = all
    .filter((f) => f.startsWith('src/') && f.endsWith('.tsx'))
    .filter((f) => {
      const { overlay, registered } = scan(f, readFileSync(f, 'utf8'));
      return overlay && !registered && !(f in exempt);
    });
  assert.deepEqual(missing, [], '这些组件渲染了弹层却没调 useBackLayer：安卓 App 里按返回键不会先关它们');
});

// 同一条命令里的变量（data-commands.mjs 用）：bash 的 X=…、export X=…、for x in …，PowerShell 的 $X = …、$env:X = …；
// 认得的环境变量（$PWD、~、$HOME、$TEMP、$env:TEMP、%TEMP%、$env:LOCALAPPDATA）换成真值；从 mktemp、系统临时目录得来的算临时目录。
// 只换得出值的才换；同一个变量赋过不同的值、用 += 或 Set-Variable 改过、值里还有认不出的变量的，当认不出。
import { homedir, tmpdir } from 'node:os';

/** 值里出现这些，就当是新建在系统临时目录里的 */
const TEMP_SOURCE = /mktemp|mkdtemp|gettemppath|new-temporaryfile|\$\{?env:(?:temp|tmp)\b|\$\{?(?:temp|tmp|tmpdir)\b|%(?:temp|tmp)%|tmpdir\(\)/;
const MAX_VALUES = 20;
const unquote = (text) => text.trim().replace(/^(["'])(.*)\1$/s, '$2');
const forward = (path) => path.replaceAll('\\', '/');

/**
 * 认得的环境变量和它们的值（小写名，正斜杠）。bash 的 $TEMP、$TMP、$TMPDIR 只认大写写法（命令文字统一成了小写，
 * 小写的 $tmp 多半是自己起的变量名），cased 是没转小写的命令文字。
 */
function knownValues(cwd, cased) {
  const temp = forward(tmpdir());
  const home = forward(homedir());
  const local = process.env.LOCALAPPDATA ? forward(process.env.LOCALAPPDATA) : '';
  return new Map([
    ['pwd', [forward(cwd)]],
    ['home', [home]],
    ['env:userprofile', [home]],
    ['env:home', [home]],
    ['userprofile', [home]],
    ...['TEMP', 'TMP', 'TMPDIR']
      .filter((name) => new RegExp('\\$\\{?' + name + '(?![\\w])').test(cased))
      .map((name) => [name.toLowerCase(), [temp]]),
    ['env:temp', [temp]],
    ['env:tmp', [temp]],
    ...(local ? [['localappdata', [local]], ['env:localappdata', [local]]] : []),
  ]);
}

/** 命令里给变量赋的值（小写名 → 原样的值，可能几个）；改法认不出的记成 null */
function assignments(text) {
  const found = new Map();
  const add = (name, value) => {
    if (found.get(name) === null) return;
    found.set(name, [...(found.get(name) ?? []), value]);
  };
  for (const m of text.matchAll(/(?:^|[\s;&|(])(?:export\s+)?([a-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|]*)/g)) add(m[1], unquote(m[2]));
  for (const m of text.matchAll(/\$(env:)?([a-z_]\w*)\s*=(?!=)\s*([^;\r\n]+)/g)) add((m[1] ?? '') + m[2], unquote(m[3]));
  for (const m of text.matchAll(/(?:^|[\s;&|])for\s+([a-z_]\w*)\s+in\s+([^;\r\n]*?)\s*;\s*do\b/g)) {
    const items = m[2].match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    for (const item of items) add(m[1], unquote(item));
  }
  const changed = /(?:set-variable|new-variable|\bsv|\bnv)\s+(?:-name\s+)?([a-z_]\w*)|\$([a-z_]\w*)\s*[-+*/.]=|foreach\s*\(\s*\$([a-z_]\w*)|\[ref\]\s*\$([a-z_]\w*)|\bread\s+(?:-\w+\s+)*([a-z_]\w*)/g;
  for (const m of text.matchAll(changed)) found.set(m.slice(1).find(Boolean), null);
  return found;
}

/** 变量名的写法：$x、${x}、$env:x、%x%（不分大小写，查值时按小写名查） */
const REFERENCE = /\$\{(env:)?([a-z_]\w*)\}|\$(env:)?([a-z_]\w*)|%([a-z_]\w*)%/gi;

/**
 * 一条命令（norm 过的小写 text，和没转小写的 cased）里各变量能取到的值：先认得的环境变量，再同一条命令里赋的；赋值里套的变量一层层展开，
 * 值里有临时目录来源的换成系统临时目录下的一个虚构目录。返回 名字 → 值的列表；认不出的不在表里。
 */
export function variableValues(text, cwd, cased = '') {
  const known = knownValues(cwd, cased);
  const raw = assignments(text);
  const resolved = new Map();
  const resolving = new Set();
  const valuesOf = (name) => {
    if (resolved.has(name)) return resolved.get(name);
    if (raw.has(name)) {
      if (raw.get(name) === null || resolving.has(name)) return null;
      resolving.add(name);
      const values = raw.get(name).flatMap((value) => {
        if (TEMP_SOURCE.test(value)) return [forward(tmpdir()) + '/erp-hooks-temp-' + name];
        const joined = /^\(?join-path\s+(?:-path\s+)?("[^"]*"|'[^']*'|\S+)\s+(?:-childpath\s+)?("[^"]*"|'[^']*'|[^\s)]+)\)?$/.exec(value);
        const plain = joined ? unquote(joined[1]) + '/' + unquote(joined[2]) : value;
        return expand(plain, valuesOf) ?? [null];
      });
      resolving.delete(name);
      const result = values.includes(null) || values.length > MAX_VALUES ? null : values;
      resolved.set(name, result);
      return result;
    }
    return known.get(name) ?? null;
  };
  for (const name of [...known.keys(), ...raw.keys()]) valuesOf(name);
  return new Map([...resolved, ...[...known].filter(([name]) => !resolved.has(name))].filter(([, values]) => values));
}

/** 一个词把里面的变量换成值（几个值就展开成几个）；有认不出的变量、命令替换或反引号返回 null */
export function expand(word, valuesOf) {
  if (/\$\(|`/.test(word)) return null;
  let results = [''];
  let last = 0;
  for (const m of word.matchAll(REFERENCE)) {
    const name = ((m[1] ?? m[3] ?? '') + (m[2] ?? m[4] ?? m[5])).toLowerCase();
    const values = typeof valuesOf === 'function' ? valuesOf(name) : valuesOf.get(name);
    if (!values) return null;
    const head = word.slice(last, m.index);
    results = results.flatMap((done) => values.map((value) => done + head + value));
    if (results.length > MAX_VALUES) return null;
    last = m.index + m[0].length;
  }
  return results.map((done) => done + word.slice(last));
}

/** 整段命令文字把认得出的变量换成值（几个值就出几份，最多 20 份；不分大小写）；认不出的原样留着 */
export function expandText(text, values) {
  let variants = [text];
  for (const [name, list] of values) {
    const source = '\\$\\{' + name + '\\}|\\$' + name + '(?![\\w:])|%' + name + '%';
    if (!variants.some((variant) => new RegExp(source, 'i').test(variant))) continue;
    variants = variants.flatMap((variant) => list.map((value) => variant.replace(new RegExp(source, 'gi'), () => value)));
    if (variants.length > MAX_VALUES) return variants.slice(0, MAX_VALUES);
  }
  return variants;
}

/** 一个词里还有没展开的变量、命令替换或反引号 */
export const unresolved = (word) => /\$(?:[\w{(]|$)|%[a-z_]\w*%|`/.test(word);

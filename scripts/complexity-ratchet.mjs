// 函数复杂度“只许变小”：不带豁免再跑一遍 eslint.config.js 里那四条，从消息里取数（行数、嵌套、参数、复杂度），
// 和基线比：变大就失败，变小了提示更新基线。基线现在是 0 项，等于超限的函数一个都不许有。
//   npm run lint:ratchet              比
//   npm run lint:ratchet -- --update  改小了以后把基线跟着改小（只改小、删掉没了的，不加新的、不改大）；没有基线时按现在的生成
// 同一个文件里同名的函数（匿名箭头函数都叫 Arrow function）不按位置配对，按数从大到小一一对比：顺序变了不误报，第 k 大的变大就拦。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASELINE = 'scripts/complexity-baseline.json';
const RULES = { 'max-lines-per-function': '行数', 'max-depth': '嵌套', 'max-params': '参数', complexity: '复杂度' };

/** ESLint 结果 → { '文件 :: 指标 :: 函数名': [数, …从大到小] }。嵌套的消息不带函数名，按文件算 */
export function measure(results, root) {
  const out = {};
  for (const r of results)
    for (const m of r.messages) {
      const label = RULES[m.ruleId];
      if (!label) continue;
      const value = Number(/\((\d+)\)|complexity of (\d+)/.exec(m.message)?.slice(1).find(Boolean));
      const name = m.ruleId === 'max-depth' ? '' : ' :: ' + m.message.split(/ has (?:too many|a complexity)/)[0];
      const key = relative(root, r.filePath).replaceAll('\\', '/') + ' :: ' + label + name;
      (out[key] ??= []).push(value);
    }
  for (const v of Object.values(out)) v.sort((a, b) => b - a);
  return out;
}

/** 和基线比：grown 变大了、fresh 基线里没有的（这两种失败）；shrunk 变小了或少了（提示更新基线） */
export function compare(now, base) {
  const grown = [],
    fresh = [],
    shrunk = [];
  for (const key of new Set([...Object.keys(now), ...Object.keys(base)])) {
    const n = now[key] ?? [],
      b = base[key] ?? [];
    n.forEach((v, i) => {
      if (i >= b.length) fresh.push({ key, now: v });
      else if (v > b[i]) grown.push({ key, was: b[i], now: v });
      else if (v < b[i]) shrunk.push({ key, was: b[i], now: v });
    });
    for (const v of b.slice(n.length)) shrunk.push({ key, was: v, now: null });
  }
  return { grown, fresh, shrunk };
}

/** 基线跟着改小：每项取较小的数，现在没有了的删掉；不加新的、不改大 */
export function tighten(now, base) {
  const out = {};
  for (const [key, b] of Object.entries(base)) {
    const n = now[key] ?? [];
    const kept = b.slice(0, n.length).map((v, i) => Math.min(v, n[i]));
    if (kept.length) out[key] = kept;
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { ESLint } = await import('eslint');
  // 用 Node 接口跑：不读豁免文件，每处超标都拿得到
  // 只跑那四条，用不着类型信息：关掉 projectService 省下建类型工程的时间
  const eslint = new ESLint({
    cwd: root,
    ruleFilter: ({ ruleId }) => ruleId in RULES,
    overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
  });
  const now = measure(await eslint.lintFiles(['server', 'shared', 'src', 'scripts', 'tests']), root);
  const file = join(root, BASELINE);
  const write = (data) => writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b))), null, 1) + '\n');
  if (!existsSync(file)) {
    if (!process.argv.includes('--update')) {
      console.log(`还没有基线 ${BASELINE}：先跑 npm run lint:ratchet -- --update 按现在的生成。`);
      process.exit(1);
    }
    write(now);
    console.log(`按现在的生成了基线：${Object.keys(now).length} 项`);
    process.exit(0);
  }
  const base = JSON.parse(readFileSync(file, 'utf8'));
  if (process.argv.includes('--update')) {
    write(tighten(now, base));
    console.log('基线已跟着改小。');
    process.exit(0);
  }
  const { grown, fresh, shrunk } = compare(now, base);
  for (const g of grown) console.log(`变大了：${g.key}  ${g.was} → ${g.now}`);
  for (const f of fresh) console.log(`新超标：${f.key}  ${f.now}`);
  if (shrunk.length) console.log(`有 ${shrunk.length} 处变小或没了，跑 npm run lint:ratchet -- --update 把基线跟着改小。`);
  if (grown.length || fresh.length) {
    console.log('登记过的函数只许变小：拆开或简化；确实要超的，先在豁免文件和基线里登记并写明原因。');
    process.exit(1);
  }
  console.log(`函数复杂度没有变大（${Object.keys(base).length} 项基线）。`);
}

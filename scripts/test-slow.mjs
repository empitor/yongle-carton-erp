// npm test 的慢测试检查：单条超过 1 秒、没在 scripts/test-exemptions.mjs 登记原因的算慢。
// 分组并行时机器忙，平时不到 1 秒的测试会被拖过线，所以并行用时只用来挑嫌疑：
// 并行越线、没登记的，和登记了、这一轮没越线的，都把所在文件单独重跑一次（只跑这几条），按单独跑的用时下结论。
// 同一份文件只重跑一次，重跑一份接一份串行做，免得重跑之间又互相拖慢。
// 单独起一份文件要 3 秒上下，一轮最多重跑 RERUN_FILES 份：按文件里越线测试的最长并行用时排，最长的先跑（真慢的并行时通常也最长），
// 没轮到的这一轮不判，结尾打一行写明还有几份文件没单独计时。
import { SLOW_MS } from './test-report.mjs';

export const RERUN_FILES = 6;

const key = (file, name) => file + '\n' + name;

/** 登记了、文件这一轮跑了，却没有这条测试（改名或删了）：[{ file, name }]。和机器快慢无关，run-tests.mjs 让命令失败 */
export function missingSlowExemptions(records, exempt) {
  const ran = new Set(records.map((r) => key(r.file, r.name)));
  const ranFiles = new Set(records.map((r) => r.file));
  return Object.entries(exempt).flatMap(([file, names]) =>
    ranFiles.has(file) ? Object.keys(names).filter((name) => !ran.has(key(file, name))).map((name) => ({ file, name })) : [],
  );
}

/**
 * 要单独计时的测试，按文件归拢、按文件里没登记的越线测试的最长并行用时从长到短排好：{ rerun: [{ file, names }], skipped: 超出上限没轮到的同样结构 }。
 * exempt：{ 文件: { 测试名: 原因 } }。只为复查登记项的文件排在最后。
 */
function pickRechecks(records, exempt) {
  const byFile = new Map();
  for (const r of records) {
    const registered = Boolean(exempt[r.file]?.[r.name]);
    if (registered === r.ms > SLOW_MS) continue;
    const f = byFile.get(r.file) ?? { file: r.file, names: [], rank: 0 };
    f.names.push(r.name);
    if (!registered) f.rank = Math.max(f.rank, r.ms);
    byFile.set(r.file, f);
  }
  const all = [...byFile.values()].sort((a, b) => b.rank - a.rank).map(({ file, names }) => ({ file, names }));
  return { rerun: all.slice(0, RERUN_FILES), skipped: all.slice(RERUN_FILES) };
}

/**
 * 按单独跑的用时下结论。records：并行一轮的用时；solo：单独重跑的用时（同样的 { file, name, ms }）；skipped：没轮到重跑的文件。
 * slow：没登记、单独跑也超过 1 秒（重跑了却没拿到用时的也算，soloMs 为 undefined）；
 * parallelOnly：没登记、并行时越线、单独跑不超；unjudged：有没登记的越线测试、却没轮到重跑的文件；
 * registered：登记过、确实慢的条数；stale：登记了、单独跑也不超，该从登记表删掉（和机器快慢有关，只提示）；
 * missing：登记了、文件跑了却找不到这条测试（missingSlowExemptions）。
 */
function judgeSlow(records, solo, exempt, skipped) {
  const soloMs = new Map(solo.map((r) => [key(r.file, r.name), r.ms]));
  const verdict = { slow: [], parallelOnly: [], unjudged: new Set(), registered: 0, stale: [], missing: missingSlowExemptions(records, exempt) };
  for (const r of records) {
    const ms = soloMs.get(key(r.file, r.name));
    const soloFast = ms !== undefined && ms <= SLOW_MS;
    if (exempt[r.file]?.[r.name]) {
      if (r.ms <= SLOW_MS && soloFast) verdict.stale.push({ file: r.file, name: r.name });
      else verdict.registered++;
    } else if (r.ms <= SLOW_MS) continue;
    else if (skipped.has(r.file)) verdict.unjudged.add(r.file);
    else verdict[soloFast ? 'parallelOnly' : 'slow'].push({ file: r.file, name: r.name, parallelMs: r.ms, soloMs: ms });
  }
  verdict.slow.sort((a, b) => (b.soloMs ?? Infinity) - (a.soloMs ?? Infinity));
  return verdict;
}

const sec = (ms) => (ms === undefined ? '没拿到' : (ms / 1000).toFixed(1) + ' 秒');

function printSlow({ slow, parallelOnly, unjudged, registered, stale, missing }, log) {
  if (slow.length) {
    log(`单独跑也超过 ${SLOW_MS / 1000} 秒、没登记原因的测试 ${slow.length} 条（改快，或在 scripts/test-exemptions.mjs 登记为什么快不了）：`);
    for (const r of slow) log(`  单独 ${sec(r.soloMs).padStart(7)}（并行 ${sec(r.parallelMs)}）  ${r.file}  ${r.name}`);
  }
  if (parallelOnly.length) log(`并行时越线、单独跑不慢的 ${parallelOnly.length} 条，不算慢。`);
  if (registered) log(`登记过原因的慢测试 ${registered} 条，不报。`);
  if (stale.length) {
    log('登记了但单独跑已经不慢了（和机器快慢有关，只提示），确认几次都不慢就从 scripts/test-exemptions.mjs 删掉：');
    for (const r of stale) log(`  ${r.file}  ${r.name}`);
  }
  if (missing.length) {
    log('登记了但这份文件里已经没有这条测试（改名或删了），这一轮算失败；从 scripts/test-exemptions.mjs 删掉或改成现在的名字：');
    for (const r of missing) log(`  ${r.file}  ${r.name}`);
  }
  if (unjudged.size) log(`还有 ${unjudged.size} 份文件越线、这一轮没单独计时（一轮最多重跑 ${RERUN_FILES} 份）。`);
}

/** 测试名 → 只认这一条的 --test-name-pattern（整名精确匹配） */
export const namePattern = (name) => '^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';

/**
 * 挑嫌疑、逐份文件串行重跑、下结论、打印；返回单独跑也慢、没登记的条数。
 * rerun(file, names)：单独跑这份文件里的这几条，返回它们的用时记录。
 */
export async function checkSlow(records, exempt, rerun, log = console.log) {
  const { rerun: files, skipped } = pickRechecks(records, exempt);
  const solo = [];
  for (const { file, names } of files) solo.push(...(await rerun(file, names)));
  const verdict = judgeSlow(records, solo, exempt, new Set(skipped.map((f) => f.file)));
  printSlow(verdict, log);
  return verdict.slow.length;
}

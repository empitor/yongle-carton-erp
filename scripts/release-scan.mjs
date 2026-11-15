// 发布内容检查：整包（package-release）和服务器补丁（patch-server）共用同一套规则，
// 两边放行和拦截的文件始终一致。只报告路径和规则，不输出文件内容。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 不该进入发布内容的目录（相对发布根目录）。 */
export const forbiddenDirectory = /^(data|backups|tests|work|outputs?|src|\.git|\.github|\.claude)(\/|$)/;
/** 不该进入发布内容的文件名：数据库、运行标记、模型文件、证书和密钥、.env。 */
export const forbiddenFileName = (name) =>
  /\.(sqlite(-\w+)?|running|control|onnx|pem|key|pfx|p12)$/i.test(name) || /^\.env$/.test(name);
/** 疑似密钥：真实 API 密钥、GitHub 令牌、私钥。测试里的虚构值（sk-fictional…）放行。 */
export const secretPattern =
  /\bsk-(?!fictional|test|fake|mock|example|dummy)[A-Za-z0-9_-]{24,}\b|gh[pousr]_[A-Za-z0-9]{30,}|BEGIN [A-Z ]*PRIVATE KEY/;
/** 超过这个大小的文件不扫内容（构建产物、字体等）。 */
export const contentScanLimit = 5_000_000;

/** 检查一个目录（发布根目录内的相对路径，用 / 分隔）。 */
export function scanDirectory(rel) {
  return forbiddenDirectory.test(rel) ? ['不该打包的目录：' + rel] : [];
}

/** 检查一个文件：文件名规则，以及小于上限时的内容。read 只在需要扫内容时调用。 */
export function scanFile(rel, size, read) {
  const problems = [];
  const name = rel.split('/').at(-1);
  if (forbiddenFileName(name)) problems.push('不该打包的文件：' + rel);
  if (size < contentScanLimit) {
    const data = read();
    if (secretPattern.test((Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('latin1')))
      problems.push('疑似密钥：' + rel);
  }
  return problems;
}

/**
 * 检查补丁这类“相对路径 → 内容”的文件清单：每一级上级目录、文件名和内容都按整包同样的规则查。
 */
export function scanFileList(entries) {
  const problems = [];
  const seen = new Set();
  for (const [rel, bytes] of entries) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (seen.has(dir)) continue;
      seen.add(dir);
      problems.push(...scanDirectory(dir));
    }
    problems.push(...scanFile(rel, bytes.length, () => bytes));
  }
  return problems;
}

/** 检查整包暂存目录。node_modules 和 runtime 是第三方内容，只查文件名不查内容。 */
export function scanTree(root) {
  const problems = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name),
        rel = relative(root, full).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        problems.push(...scanDirectory(rel));
        walk(full);
        continue;
      }
      if (rel.startsWith('node_modules/') || rel.startsWith('runtime/')) {
        if (forbiddenFileName(entry.name)) problems.push('不该打包的文件：' + rel);
        continue;
      }
      problems.push(...scanFile(rel, statSync(full).size, () => readFileSync(full)));
    }
  };
  walk(root);
  return problems;
}

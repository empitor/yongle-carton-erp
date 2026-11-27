// 生成文档用的 Markdown 小工具：表格、代码段，和把注释里的代码名字套上反引号（codeSpans）。
import { existsSync } from 'node:fs';

/** 生成文件开头那几行：标题、什么时候读、怎么生成（三份都一样写） */
export function docHeader(title: string, when: string, source: string) {
  return [`# ${title}`, '', `什么时候读：${when}。`, '',`由 \`npm run docs:gen\` 生成，不手改：${source}`, ''];
}

/** 表格单元格：竖线转义，换行并成一行 */
const cell = (text: string) => text.replace(/\r?\n/g, ' ').replaceAll('|', '\\|');
/** 一段代码；里面有反引号时用两个反引号包 */
export const code = (text: string) => (text.includes('`') ? '`` ' + text + ' ``' : '`' + text + '`');

/** Markdown 表格 */
export function table(head: string[], rows: string[][]) {
  return [
    '| ' + head.join(' | ') + ' |',
    '|' + head.map(() => '---').join('|') + '|',
    ...rows.map((row) => '| ' + row.map(cell).join(' | ') + ' |'),
    '',
  ];
}

/** 注释里的一串可能是代码的字符（字母开头，带 . / - 和 <占位> 的整段） */
const TOKEN = /[A-Za-z_][\w$./-]*(?:<[^<>\s]+>[\w$./-]*)*/g;
/** 项目代码目录开头的路径：要真有这个文件或目录 */
const PROJECT_PATH = /^(?:server|shared|src|tests|scripts)\//;
/** 带扩展名的文件名 */
const FILE_NAME = /\.(?:ts|tsx|mts|mjs|js|json|sql|sqlite|md|key|log|docx|xlsx)$/;
/** 驼峰写法（小写开头）：函数名、字段名 */
const CAMEL = /^[a-z][a-z0-9]*[A-Z]/;

export type SpanOptions = {
  /** 光看写法认不出、但要当代码的名字：表名、列名、枚举值 */
  known: ReadonlySet<string>;
  /** 写到的项目路径不存在就报错（语句前面的注释能改，就要改对）；括号里的注释是库结构的一部分，只套存在的 */
  strict: boolean;
  /** 报错时说是哪里的注释 */
  where: string;
};

/** 一串字符是不是代码；是项目路径的顺带核对存在 */
function isCode(token: string, options: SpanOptions) {
  if (PROJECT_PATH.test(token)) {
    const exists = token.includes('<') || existsSync(token.replace(/\/$/, ''));
    if (!exists && options.strict) throw new Error(`${options.where}的注释里写的路径不存在：${token}。改成现在的位置再生成`);
    return exists;
  }
  if (token.includes('/')) return token.endsWith('/') || FILE_NAME.test(token);
  if (FILE_NAME.test(token) || options.known.has(token)) return true;
  if (/[-/]/.test(token)) return false;
  return token.includes('_') || token.includes('.') || token.includes('<') || CAMEL.test(token);
}

/** 文档和技能的路径（名字可以是中文，.claude/ 带点开头）整段当代码 */
const DOC_PATH = /((?:docs|\.claude)\/[^\s`，。；：、（）“”()]+)/;

/** 没有反引号的一段：文档路径整段套，别的逐串看是不是代码 */
function wrapPlain(text: string, options: SpanOptions) {
  return text
    .split(DOC_PATH)
    .map((piece, i) =>
      i % 2
        ? '`' + piece + '`'
        : piece.replace(TOKEN, (raw) => {
            const token = raw.replace(/[.-]+$/, '');
            return isCode(token, options) ? '`' + token + '`' + raw.slice(token.length) : raw;
          }),
    )
    .join('');
}

/** 把一行说明里的代码名字套上反引号；已经在反引号里的不动 */
export function codeSpans(line: string, options: SpanOptions) {
  return line
    .split(/(`[^`]*`)/)
    .map((piece) => (piece.startsWith('`') ? piece : wrapPlain(piece, options)))
    .join('');
}

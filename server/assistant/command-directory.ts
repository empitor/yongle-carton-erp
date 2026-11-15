// 命令目录：把这个账号能用的命令（工具注册表 exposed(actor) 给出的那些）印成给模型看的文字，
// 代替把所有工具都作为原生工具发出去。常驻给模型的只有三样：常用的十来条命令作为真正的原生工具（commonCommands）、
// 其余命令的目录（按组分小节，每条一行“名字：说明第一句”）、三个通用工具（找命令、查用法、执行命令）。
// 这里只有纯函数和常量，输入是注册表给出的命令（名字、说明、所属组、参数结构）；接进请求和分派在对话层。
import { trimSchema, type ModelTool } from './chat/model-tools.js';

/** 注册表 exposed(actor) 的一条：module 是所属组（现在是插件名） */
export type DirectoryCommand = { name: string; description: string; module: string; parameters: unknown };

/**
 * 常用命令：这个账号能用的那几条作为真正的原生工具发给模型（带完整说明和参数结构），直接调，不用先查用法；其余走目录。
 * 名单依据真实模型全量测试里模型自己调得最多的。不把用法印在目录里：印出来的模型会当成原生工具直接调，白费一次请求。
 */
export const commonCommands = [
  'records.search',
  'records.get',
  'records.summarize',
  'records.propose_save',
  'finance.summary',
  'finance.monthly',
  'inbox.list',
  'order_batch.list',
  'web.search',
  'web.read',
  'memory.search',
  'guide.read',
  'ui.open',
] as const;

/** 说明的第一句（到第一个句号为止，不含句号）：讲什么时候用，目录里只印这一句 */
export function firstSentence(description: string) {
  const end = description.indexOf('。');
  return (end < 0 ? description : description.slice(0, end)).trim();
}

/** 页面上怎么叫这条命令（状态行“正在〈叫法〉…”、“没做成：〈叫法〉”）：说明第一个标点前的字，不露英文命令名 */
export function commandLabel(description: string | undefined, name: string) {
  return description?.split(/[。：；，（(]/)[0] || name;
}

/** 目录文字：组按第一次出现的顺序、组内按注册表顺序，每条命令一行 */
export function commandDirectory(commands: readonly DirectoryCommand[]) {
  const groups = new Map<string, string[]>();
  for (const c of commands) groups.set(c.module, [...(groups.get(c.module) ?? []), c.name + '：' + firstSentence(c.description)]);
  return [...groups].map(([group, lines]) => '## ' + group + '\n' + lines.join('\n')).join('\n\n');
}

/** 一条命令的用法：完整说明加精简后的参数结构（和原生工具同一个 trimSchema）。查用法返回它 */
export function commandUsage(command: DirectoryCommand) {
  return '### ' + command.name + '\n' + command.description + '\n参数：' + JSON.stringify(trimSchema(command.parameters));
}

/** 几条命令的用法；不在这个账号可用命令里的，说清楚没有，不抛错（模型照着换一条） */
export function commandUsages(commands: readonly DirectoryCommand[], names: readonly string[]) {
  const byName = new Map(commands.map((c) => [c.name, c]));
  return names
    .map((name) => {
      const command = byName.get(name);
      return command ? commandUsage(command) : '### ' + name + '\n没有这条命令，或当前账号不能用。';
    })
    .join('\n\n');
}

/** 找命令打分：几个字以上的中文词才拆成相邻两个字算、拆开对上的按一半算；说明里出现的次数最多算几次、每次加多少 */
const PAIR_TERM_CHARS = 3;
const PAIR_WEIGHT = 0.5;
const MAX_COUNTED_REPEATS = 5;
const REPEAT_WEIGHT = 0.1;

/** 一个词在文字里对上多少：整个词对上算 1；中文连写的词（“登记到货”）拆成相邻两个字，按对上的比例算一半 */
function termHit(term: string, text: string) {
  if (text.includes(term)) return 1;
  if (term.length < PAIR_TERM_CHARS) return 0;
  const pairs = Array.from({ length: term.length - 1 }, (_, i) => term.slice(i, i + 2));
  return (pairs.filter((p) => text.includes(p)).length / pairs.length) * PAIR_WEIGHT;
}

/**
 * 按关键词找命令：空格分开的几个词，名字和第一句里对上的分量重，组名和完整说明里对上的轻；
 * 同分时说明里这个词出现得多的靠前（讲的就是这件事）。返回名字和第一句。
 */
export function findCommands(commands: readonly DirectoryCommand[], query: string, limit = 8) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return commands
    .map((c, order) => {
      const head = (c.name + ' ' + firstSentence(c.description)).toLowerCase(),
        rest = (c.module + ' ' + c.description).toLowerCase();
      const score = terms.reduce((n, t) => n + Math.max(termHit(t, head) * 2, termHit(t, rest)) + Math.min(rest.split(t).length - 1, MAX_COUNTED_REPEATS) * REPEAT_WEIGHT, 0);
      return { c, order, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(({ c }) => ({ name: c.name, summary: firstSentence(c.description) }));
}

/** 三个通用工具：找命令、查用法、执行目录里的命令 */
export const commandTools: ModelTool[] = [
  {
    type: 'function',
    function: {
      name: 'find_command',
      description: '目录里没看到合适的命令、或拿不准是哪条时，按关键词找，返回对得上的几条和它们的一句话。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '关键词，空格分开几个词，比如“到货 登记”' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'command_usage',
      description: '看命令的完整说明和参数结构；执行一条还没看过用法的命令之前先查。',
      parameters: {
        type: 'object',
        properties: { names: { type: 'array', items: { type: 'string' }, description: '目录里的命令名，可以一次查几条' } },
        required: ['names'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '执行一条命令：name 用目录里的名字，args 照用法里的参数结构写。参数不对时报错里会带上正确用法。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, args: { type: 'object' } },
        required: ['name', 'args'],
      },
    },
  },
];

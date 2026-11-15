// 命令怎么发给模型（命令目录的纯函数在 command-directory.ts）：常用的十来条（这个账号能用的那几条）作为真正的原生工具，直接调；
// 其余命令常驻一份目录（每条一行），用到时先查用法，再用 run_command 执行。两条路进同一条分派
// （tool-step.ts：校验、权限、只读直接执行、写入出卡片）。同一账号整个对话里 tools 和目录都不变，吃前缀缓存。
import type { ChatTool } from '../../ai/index.js';
import { commandDirectory, commandTools, commandUsage, commandUsages, commonCommands, findCommands, type DirectoryCommand } from '../command-directory.js';
import { buildModelTools } from './model-tools.js';
import type { ToolCall } from './run-state.js';
import { isRecord } from './result-fields.js';

const [FIND, USAGE, RUN] = commandTools.map((t) => t.function.name);
const common: ReadonlySet<string> = new Set(commonCommands);

/** 这一轮发给模型的 tools（常用命令在前，三个通用工具在后）和名字反查表（发给模型的名字 → 注册表名字，通用工具就是它自己） */
export function requestTools(commands: readonly DirectoryCommand[]): { tools: ChatTool[]; registryName: Map<string, string> } {
  const direct = buildModelTools(commands.filter((c) => common.has(c.name)));
  for (const t of commandTools) direct.registryName.set(t.function.name, t.function.name);
  return { tools: [...direct.tools, ...commandTools], registryName: direct.registryName };
}

/** 目录那条系统消息：按组列出这个账号能用、没有直接作为工具给的命令。同一账号整个对话不变。 */
export function directoryMessage(commands: readonly DirectoryCommand[]) {
  const rest = commands.filter((c) => !common.has(c.name));
  if (!rest.length) return [];
  return [
    {
      role: 'system' as const,
      content: '# 命令目录（除了直接给你的工具，当前账号还能用这些命令，用 run_command 执行；每行是“名字：什么时候用”）\n\n' + commandDirectory(rest),
    },
  ];
}

/**
 * 模型调的是通用工具时怎么办：找命令、查用法当场给结果（done）；执行命令拆出里面那条命令（call），接着走普通分派。
 * 名字不在这个账号能用的命令里：不执行，告诉它没有这条。直接调的常用命令原样往下走。
 */
export function unwrapCommand(commands: readonly DirectoryCommand[], call: ToolCall): { done: unknown } | { call: ToolCall } | { missing: string } {
  if (call.name === FIND) return { done: { 命令: findCommands(commands, String(call.args.query ?? '')) } };
  if (call.name === USAGE)
    return { done: { 用法: commandUsages(commands, Array.isArray(call.args.names) ? call.args.names.map(String) : []) } };
  if (call.name !== RUN) return { call };
  const name = String(call.args.name ?? '');
  if (!commands.some((c) => c.name === name)) return { missing: `没有“${name}”这条命令，或当前账号不能用。` };
  return { call: { name, args: isRecord(call.args.args) ? call.args.args : {} } };
}

/** 经 run_command 执行、参数不对时接在报错后面的话：这条命令的正确用法，模型照着改，不用再查一次 */
export function usageHint(commands: readonly DirectoryCommand[], name: string) {
  const command = commands.find((c) => c.name === name);
  return command ? '\n正确用法：\n' + commandUsage(command) : '';
}

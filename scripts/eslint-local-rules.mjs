// eslint.config.js 用的两条项目自己的规则（现成的规则做不到按位置、按类型判断，所以在现成规则上补一层）。
//
// no-magic-numbers：typescript-eslint 的 no-magic-numbers，只多放过写在 HTTP 状态码位置上的数。
//   res.status(409)、new AppError('…', 404)、financeError('…', 409)、{ status: 503 }、e.upstreamStatus === 404 这类一眼就懂，不起名。
//   现成的规则只能按数值放过，那样 200、500 当长度上限写死时也会漏掉。位置：传给名字带 status 的参数（按类型信息找到被调函数的参数名）、
//   名字带 status 的函数（res.status()、sendStatus()）、属性和比较；中间隔着 ?:、??、||、as 也算（e instanceof AppError ? e.status : 422）。
// no-direct-db-read：服务端不直接 prepare(…).get/all/iterate 读库。按类型认 node:sqlite 的语句对象，
//   所以先存进变量再 .get() 的写法也拦得住（选择器只认得出连着写的）。
import tseslint from 'typescript-eslint';

const base = tseslint.plugin.rules['no-magic-numbers'];
const STATUS = /status/i;
const PASS_THROUGH = new Set(['ConditionalExpression', 'LogicalExpression', 'TSAsExpression', 'TSSatisfiesExpression']);

const nameOf = (n) =>
  n?.type === 'Identifier' ? n.name : n?.type === 'MemberExpression' ? nameOf(n.property) : n?.type === 'Literal' ? String(n.value) : '';

/** 实参对应的形参名（按类型信息解析出被调的那个签名） */
function parameterName(services, call, index) {
  const signature = services.program.getTypeChecker().getResolvedSignature(services.esTreeNodeToTSNodeMap.get(call));
  const params = signature?.getParameters() ?? [];
  return params[Math.min(index, params.length - 1)]?.getName() ?? '';
}

/** 这个数字是不是写在 HTTP 状态码的位置上 */
function atStatusCode(node, services) {
  if (node.type !== 'Literal' || typeof node.value !== 'number' || node.value < 100 || node.value > 599) return false;
  let at = node;
  while (PASS_THROUGH.has(at.parent.type) && at.parent.test !== at) at = at.parent;
  const p = at.parent;
  if ((p.type === 'CallExpression' || p.type === 'NewExpression') && p.arguments.includes(at))
    return STATUS.test(nameOf(p.callee)) || STATUS.test(parameterName(services, p, p.arguments.indexOf(at)));
  if (p.type === 'Property' && p.value === at) return STATUS.test(nameOf(p.key));
  if (p.type === 'BinaryExpression' && /^([!=]==?|[<>]=?)$/.test(p.operator)) return STATUS.test(nameOf(p.left === at ? p.right : p.left));
  return false;
}

const magicNumbers = {
  ...base,
  create(context) {
    const services = context.sourceCode.parserServices;
    const report = (d) => atStatusCode(d.node, services) || context.report(d);
    return base.create(Object.create(context, { report: { value: report } }));
  },
};

const READS = new Set(['get', 'all', 'iterate']);
const directDbRead = {
  meta: {
    type: 'problem',
    messages: { read: '读库用 server/core 的 one、many、exists、count（在那里按结构校验），不直接 prepare(…).{{method}}()。' },
    schema: [],
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    const checker = services.program.getTypeChecker();
    return {
      'CallExpression > MemberExpression.callee'(member) {
        if (member.property.type !== 'Identifier' || !READS.has(member.property.name)) return;
        const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(member.object));
        if (type.getSymbol()?.getName() === 'StatementSync') context.report({ node: member.property, messageId: 'read', data: { method: member.property.name } });
      },
    };
  },
};

export const localRules = { 'no-magic-numbers': magicNumbers, 'no-direct-db-read': directDbRead };

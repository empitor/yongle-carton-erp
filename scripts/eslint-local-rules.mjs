// 项目自己的几条 eslint 规则（现成的规则做不到按位置、按类型判断，所以在现成规则上补一层）。
//
// no-magic-numbers：typescript-eslint 的 no-magic-numbers，只多放过写在 HTTP 状态码位置上的数。
//   res.status(409)、new AppError('…', 404)、financeError('…', 409)、{ status: 503 }、e.upstreamStatus === 404 这类一眼就懂，不起名。
//   现成的规则只能按数值放过，那样 200、500 当长度上限写死时也会漏掉。位置：传给名字带 status 的参数（按类型信息找到被调函数的参数名）、
//   名字带 status 的函数（res.status()、sendStatus()）、属性和比较；中间隔着 ?:、??、||、as 也算（e instanceof AppError ? e.status : 422）。
// no-direct-db-read：服务端不直接 prepare(…).get/all/iterate 读库。按类型认 node:sqlite 的语句对象，
//   所以先存进变量再 .get() 的写法也拦得住（选择器只认得出连着写的）。
// no-flow-literals：SQL 字符串里写死的单据状态、种类和 flow_ 记录种类（no-restricted-syntax 的选择器只能整串比，
//   认不出 SQL 中间的一段，也分不出模板字符串里由常量拼的部分）。范围在 eslint.config.js：server/ 下除单据流转
//   （只读窗口 finance-facts 要查）、建表、财务（财务表的状态同名）。
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

// 单据的状态、种类（shared/business/physical-flow.ts 的 flowStatus、flowKinds）：词表在这里另写一份，
// 规则的样例测试（tests/eslint-flow-literals.test.ts）逐个拿 shared 的常量比，两边对不上就报红
const FLOW_STATUSES = ['draft', 'confirmed', 'cancelled', 'reversed'];
const FLOW_KINDS = ['arrival', 'task', 'production', 'delivery'];
const quotedWord = (words) => `'(?:${words.join('|')})'`;
/** SQL 里比单据状态、种类写死的值：status='draft'、f.status IN ('confirmed','reversed')、kind='task'，和带引号的 'flow_…' */
const SQL_LITERALS = [
  new RegExp(String.raw`\bstatus\s*(?:=|!=|<>)\s*` + quotedWord(FLOW_STATUSES), 'i'),
  new RegExp(String.raw`\bstatus\s+(?:NOT\s+)?IN\s*\([^)]*` + quotedWord(FLOW_STATUSES), 'i'),
  new RegExp(String.raw`\bkind\s*(?:=|!=|<>)\s*` + quotedWord(FLOW_KINDS), 'i'),
  new RegExp(String.raw`\bkind\s+(?:NOT\s+)?IN\s*\([^)]*` + quotedWord(FLOW_KINDS), 'i'),
  /'flow_\w*'/,
];
/** 单据的记录种类（归档标记、审计、流水来源）写成字面值：'flow_' 本身和 flow_ 加单据种类、flow_reversal */
const FLOW_ENTITY = new RegExp(`^flow_(?:${[...FLOW_KINDS, 'reversal'].join('|')})?$`);
// 模板字符串里插进来的值换成这个字，status='${flowStatus.draft}' 这种由常量拼的就不算写死
const HOLE = '\u0000';

const flowLiterals = {
  meta: {
    type: 'problem',
    messages: {
      sql: 'SQL 里不写死单据状态、种类和 flow_ 记录种类：用 shared/business 的 flowStatus、flowEntity、movementSource 拼，或者传参数。',
      entity: '单据的记录种类用 shared/business 的 flowEntity(种类)、flowEntityPrefix 或 movementSource，不写 flow_ 字面值。',
    },
    schema: [],
  },
  create(context) {
    const checkSql = (node, text) => SQL_LITERALS.some((re) => re.test(text)) && context.report({ node, messageId: 'sql' });
    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        if (FLOW_ENTITY.test(node.value)) context.report({ node, messageId: 'entity' });
        else checkSql(node, node.value);
      },
      TemplateLiteral(node) {
        checkSql(node, node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(HOLE));
      },
    };
  },
};

export const localRules = { 'no-magic-numbers': magicNumbers, 'no-direct-db-read': directDbRead, 'no-flow-literals': flowLiterals };

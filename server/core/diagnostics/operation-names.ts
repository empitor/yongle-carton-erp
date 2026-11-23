/**
 * 接口地址对应的操作叫法（给人看的中文，比如 POST /api/order-batches/12/receive → 登记到货）。
 * 先按具体动作对，对不上再按“资源 + 读写方式”拼；都对不上叫“其他操作”，接口地址另外记，不会丢线索。
 * 纯函数，不碰请求和库。
 */

/** 具体动作：[方法（* 表示都算）, 去掉 /api 以后的地址, 叫法]，从上往下第一条对上的算 */
const actions: [string, RegExp, string][] = [
  ['POST', /^\/auth\/(login|setup)$/, '登录'],
  ['POST', /^\/auth\/logout$/, '退出登录'],
  ['POST', /^\/auth\/password$/, '改密码'],
  ['POST', /^\/auth\/super-admin\/enter$/, '进入超级管理员模式'],
  ['POST', /^\/auth\/super-admin\/exit$/, '退出超级管理员模式'],
  ['POST', /^\/auth\/apply$/, '申请账号'],
  ['POST', /^\/auth\/forgot$/, '忘记密码'],
  ['POST', /^\/auth\/users\/[^/]+\/password$/, '给账号换临时密码'],
  ['POST', /^\/auth\/requests\/[^/]+\/approve$/, '批准账号申请'],
  ['POST', /^\/auth\/requests\/[^/]+\/reject$/, '拒绝账号申请'],
  ['POST', /^\/order-batches\/[^/]+\/receive$/, '登记到货'],
  ['POST', /^\/flow\/[^/]+\/correct(ion-preview)?$/, '更正单据'],
  ['POST', /^\/flow\/task$/, '安排生产'],
  ['POST', /^\/flow\/delivery$/, '安排送货'],
  ['POST', /^\/flow\/production-completion\//, '登记完工'],
  ['POST', /^\/flow\/returns\/[^/]+\/reverse$/, '撤销采购退货'],
  ['POST', /^\/flow\/returns$/, '采购退货'],
  ['POST', /^\/flow\/[^/]+\/reverse$/, '撤销单据'],
  ['POST', /^\/flow\/[^/]+\/confirm$/, '核对入库'],
  ['POST', /^\/flow\/[^/]+\/delivered$/, '确认送达'],
  ['POST', /^\/flow\/[^/]+\/cancel$/, '取消单据'],
  ['POST', /^\/flow\/batch$/, '归档或恢复单据'],
  ['*', /^\/flow\/[^/]+\/schedule$|^\/order-batches\/[^/]+\/schedule$/, '排日期'],
  ['POST', /^\/flow\/[^/]+\/info$/, '改单据说明'],
  ['POST', /^\/warehouse\/items\/[^/]+\/move$/, '出入库'],
  ['POST', /^\/order-batches\/draft$/, '准备订货单'],
  ['POST', /^\/deletions\/preview$/, '删除前预览'],
  ['POST', /^\/deletions\/execute$/, '删除'],
  ['POST', /^\/[^/]+\/batch$/, '批量归档或恢复'],
  ['POST', /^\/documents\/[^/]+\/complete$/, '确认交付'],
  ['POST', /^\/documents\/preview/, '预览单据排版'],
  ['POST', /^\/documents$/, '导出单据'],
  ['POST', /^\/inbox\/[^/]+\/convert$/, '收件箱转成识别'],
  ['POST', /^\/inbox\/upload$/, '上传到收件箱'],
  ['POST', /^\/ai\/imports\/upload$/, '上传识别文件'],
  ['POST', /^\/ai\/imports\/batch$/, '归档或恢复识别文件'],
  ['POST', /^\/ai\/imports\/delete-many$/, '永久删除识别文件'],
  ['POST', /^\/ai\/imports\/[^/]+\/preview$/, '导入前预览'],
  ['POST', /^\/ai\/imports\/[^/]+\/execute$/, '执行导入'],
  ['POST', /^\/ai\/imports\/[^/]+\/(analyze|enqueue)$/, '开始识别'],
  ['POST', /^\/assistant\/threads\/[^/]+\/chat$/, '和助手对话'],
  ['POST', /^\/assistant\/previews\/[^/]+\/execute$/, '确认助手的操作'],
  ['POST', /^\/assistant\/transcribe$/, '语音转文字'],
  ['POST', /^\/management\/execute$/, '数据管理执行'],
  ['POST', /^\/management\/reset$/, '初始化数据'],
  ['POST', /^\/diagnostics\/page-problems$/, '上报页面报错'],
];

/** 资源叫法：按地址开头对，长的先对 */
const resources: [string, string][] = [
  ['/auth/users', '账号'],
  ['/auth/requests', '账号申请'],
  ['/auth', '登录状态'],
  ['/business', '业务总览'],
  ['/dashboard', '经营概览'],
  ['/customers', '客户'],
  ['/products', '产品'],
  ['/orders', '订单'],
  ['/suppliers', '供应商'],
  ['/purchases', '采购单'],
  ['/warehouse/movements', '库存流水'],
  ['/warehouse', '库存品'],
  ['/order-batches', '订货单'],
  ['/marks', '唛头'],
  ['/flow/stock-batches', '成品批次'],
  ['/flow/arrival-records', '到货记录'],
  ['/flow/sources', '送货单原件'],
  ['/flow', '单据'],
  ['/documents/templates', '单据模板'],
  ['/documents', '单据导出'],
  ['/finance/vouchers', '凭证'],
  ['/finance/cash', '收付款'],
  ['/finance/invoices', '发票'],
  ['/finance/closing', '结账'],
  ['/finance/reports', '财务报表'],
  ['/finance/settings', '财务设置'],
  ['/finance/payroll', '工资'],
  ['/finance/assets', '固定资产'],
  ['/finance/expenses', '费用'],
  ['/finance/bank', '银行流水'],
  ['/finance', '财务'],
  ['/ai/settings', 'AI 设置'],
  ['/ai/prompt-modules', '提示词'],
  ['/ai/imports', 'AI 识别'],
  ['/ai', 'AI 设置'],
  ['/inbox', '收件箱'],
  ['/assistant', '助手'],
  ['/management', '数据管理'],
  ['/deletions', '删除'],
  ['/diagnostics', '诊断记录'],
];
const verbs: Record<string, string> = { GET: '查看', POST: '保存', PUT: '修改', PATCH: '修改', DELETE: '删除' };

export function operationName(method: string, path: string): string {
  const m = method.toUpperCase(),
    p = path.replace(/^\/api(?=\/|$)/i, '').replace(/\/+$/, '') || '/';
  for (const [want, pattern, name] of actions) if ((want === '*' || want === m) && pattern.test(p)) return name;
  const resource = resources.find(([prefix]) => p === prefix || p.startsWith(prefix + '/'));
  return resource ? (verbs[m] ?? '操作') + resource[1] : '其他操作';
}

/** 已知接口的第一段（auth、orders、flow……），从上面的资源表来 */
const knownRoots = new Set(resources.map(([prefix]) => prefix.split('/')[1]));
/** 记录里的地址留几段、每段几个字、整串几个字 */
const ROUTE_LIMITS = { segments: 2, segmentChars: 30, pathChars: 80 };

/**
 * 记录里存的地址：不存原样（地址可以被人写成任意文字），只按路由留 /api 加前两段，
 * 每段只留小写字母、数字、-，整串 80 字以内；第一段不是已知接口的只记 /api。
 */
export function routePath(path: string): string {
  const parts = path
    .toLowerCase()
    .split('?')[0]
    .replace(/^\/api(?=\/|$)/, '')
    .split('/')
    .filter(Boolean)
    .slice(0, ROUTE_LIMITS.segments)
    .map((p) => p.replace(/[^a-z0-9-]/g, '').slice(0, ROUTE_LIMITS.segmentChars))
    .filter(Boolean);
  return parts.length && knownRoots.has(parts[0]) ? ('/api/' + parts.join('/')).slice(0, ROUTE_LIMITS.pathChars) : '/api';
}

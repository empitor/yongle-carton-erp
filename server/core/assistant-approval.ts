// 能力凭据只存在服务端内存，不能从JSON请求或模型输出构造。
// 只有助手的执行器在人点了确认卡片、执行那份方案时现发一个（assistant/tools/records-save.ts、数据管理的助手命令），业务服务凭它才收“助手来源”的写入。
const grants = new WeakMap<object, string>();
export function reviewedAssistantGrant(actorId: string) {
  const grant = Object.freeze({});
  grants.set(grant, actorId);
  return grant;
}
export function validAssistantGrant(grant: unknown, actorId: string | null) {
  return !!grant && typeof grant === 'object' && grants.get(grant) === actorId;
}

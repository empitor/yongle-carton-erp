// 能力凭据只存在服务端内存，不能从JSON请求或模型输出构造。
// 仅受控助手执行器使用：明确用户指令的单条常规操作，或人工核对的高风险方案。
const grants = new WeakMap<object, string>();
export function reviewedAssistantGrant(actorId: string) {
  const grant = Object.freeze({});
  grants.set(grant, actorId);
  return grant;
}
export function validAssistantGrant(grant: unknown, actorId: string | null) {
  return !!grant && typeof grant === 'object' && grants.get(grant) === actorId;
}

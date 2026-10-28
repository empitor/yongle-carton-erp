import type { AssistantBusinessTask } from '../../shared/assistant-task.js';
const domains = (text: string) =>
  [
    ['orders', /客户订单|销售订单|订单导入|导入.*订单|订单.*导入|交期|客户采购/],
    ['purchases', /供应商|采购需求|采购单|采购订货|订购|订货/],
    ['stock', /库存|仓库|入库|出库|到货/],
    ['production', /生产|领料|完工/],
    ['products', /产品|型号|尺寸单位/],
    ['customers', /客户/],
  ]
    .filter(([, re]) => (re as RegExp).test(text))
    .map(([name]) => name as string);
/** 只决定任务归属，不决定操作权限或业务授权。模型仍可通过taskControl补充语义判断。 */
export function startsIndependentTask(text: string, current: AssistantBusinessTask | null) {
  if (!current || /^(?:继续|接着|接上|恢复|核验|确认|没问题|好的|按刚才|下一步)/.test(text.trim()))
    return false;
  if (
    /^(?:解释|说明|介绍|查询|查看|统计|汇总|列出|这个.*是什么)/.test(text.trim()) &&
    !/继续(?:处理|生产|执行|完成)/.test(text)
  )
    return true;
  const action =
    /创建|新建|新增|修改|更改|更新|删除|清空|归档|恢复|导入|采购|订购|生产|送货|发出|发货|入库/.test(
      text,
    );
  if (!action) return false;
  if (current.state === 'completed' || /新任务|另一项|另外.*(?:创建|处理)|永久清空/.test(text))
    return true;
  const before = domains(current.goal),
    next = domains(text);
  return next.length > 0 && before.length > 0 && next.every((d) => !before.includes(d));
}

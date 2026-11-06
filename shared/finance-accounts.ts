import type { z } from 'zod';
import type { accountSchema } from './finance.js';

const groups = {
  asset:
    '1001 库存现金|1002 银行存款|1012 其他货币资金|1101 短期投资|1121 应收票据|1122 应收账款|1123 预付账款|1131 应收股利|1132 应收利息|1221 其他应收款|1401 材料采购|1402 在途物资|1403 原材料|1404 材料成本差异|1405 库存商品|1407 商品进销差价|1408 委托加工物资|1411 周转材料|1421 消耗性生物资产|1501 长期债券投资|1511 长期股权投资|1601 固定资产|1602 累计折旧|1604 在建工程|1605 工程物资|1606 固定资产清理|1621 生产性生物资产|1622 生产性生物资产累计折旧|1701 无形资产|1702 累计摊销|1801 长期待摊费用|1901 待处理财产损溢',
  liability:
    '2001 短期借款|2201 应付票据|2202 应付账款|2203 预收账款|2211 应付职工薪酬|2221 应交税费|2231 应付利息|2232 应付利润|2241 其他应付款|2401 递延收益|2501 长期借款|2701 长期应付款|222101 应交增值税|22210101 进项税额|22210102 销项税额|22210103 进项税额转出|22210104 已交税金|22210105 未交增值税|222102 应交城市维护建设税|222103 应交教育费附加|222104 应交地方教育附加|222105 应交企业所得税',
  equity: '3001 实收资本|3002 资本公积|3101 盈余公积|3103 本年利润|3104 利润分配',
  cost: '4001 生产成本|4101 制造费用|4301 研发支出|4401 工程施工|4403 机械作业|400101 直接材料|400102 直接人工|400103 制造费用',
  profit:
    '5001 主营业务收入|5051 其他业务收入|5111 投资收益|5301 营业外收入|5401 主营业务成本|5402 其他业务成本|5403 税金及附加|5601 销售费用|5602 管理费用|5603 财务费用|5711 营业外支出|5801 所得税费用',
} as const;

type Account = z.infer<typeof accountSchema>;
const creditAssets = new Set(['1407', '1602', '1622', '1702']);
const debitTax = new Set(['22210101', '22210104']);
export const presetAccounts: Account[] = (Object.keys(groups) as Account['category'][]).flatMap(
  (category) =>
    groups[category].split('|').map((item) => {
      const [code, name] = item.split(' ');
      const credit =
        category === 'equity' ||
        (category === 'liability' && !debitTax.has(code)) ||
        creditAssets.has(code) ||
        (category === 'profit' && code < '5401');
      return {
        code,
        name,
        category,
        direction: credit ? 'credit' : 'debit',
        enabled: true,
        cashKind: code === '1001' ? 'cash' : code === '1002' ? 'bank' : null,
        auxiliary: ['1122', '2203'].includes(code)
          ? 'customer'
          : ['2202', '1123'].includes(code)
            ? 'supplier'
            : null,
      };
    }),
);

// 第 4 类：看文件。图片、PDF、Word、Excel 各一份虚构文件，问文件里的具体数；隔几轮再问以前的附件；同一份文件问 3 次看稳不稳；
// 附件太大时服务器和助手怎么说（上限 10 MB）。供应商送货单识别、唛头挂到产品在 real-scenes-tools-import.mjs（M7、M9a）。
import { check } from './real-scenes-kit.mjs';

const S = ({ expect, ...scene }) => ({ domain: 'files', account: 'local', ...scene, expect: { writes: false, ...expect } });
export const scenes = [
  S({ id: 'FL1', title: 'PDF 扫描件', look: '单价 3.21、1500 张、总价 4815', turns: [{ say: '这份报价单上 BC五层纸板 单价多少、数量多少、总价多少？', attach: ['scanPdf'] }], expect: { reply: { has: ['3.21', /1,?500/, /4,?815/] } } }),
  S({ id: 'FL2', title: 'Word', look: '2400 只；12 月 10 日前第一批 1000 只', turns: [{ say: '这份需求说明里食品礼盒外箱要多少只？第一批什么时候要、要多少？', attach: ['docx'] }], expect: { reply: { has: ['2400', '1000', /12\s*月\s*10/] } } }),
  S({ id: 'FL3', title: 'Excel', look: '水壶外箱 2.1234 元、2026-12-08', turns: [{ say: '这张表里水壶外箱单价多少、交期哪天？', attach: ['orderXlsx'] }], expect: { reply: { has: ['2.1234', /12\s*月\s*8|12-08/] } } }),
  S({ id: 'FL4', title: '图片', look: '灯具内托箱 1800 只、0.95 元', turns: [{ say: '图片上灯具内托箱要多少只、单价多少？', attach: ['orderPng'] }], expect: { reply: { has: ['1800', '0.95'] } } }),
  S({ id: 'FL5', title: '隔几轮再问以前的附件', look: '第五句问报价单号，答 HM-Q-5521',
    turns: [{ say: '这份报价单是哪家的？', attach: ['scanPdf'] }, '今天几号？', '虚构东海电器有限公司的电话是多少？', '最近有哪些到货？', '前面那份报价单的报价单号是多少？'],
    expect: { reply: { has: ['HM-Q-5521'] } } }),
  S({ id: 'FL6', title: '同一份 PDF 问三次', look: '三次都答 3.21',
    turns: [{ say: '这份报价单上 BC五层纸板 单价多少？', attach: ['scanPdf'] }, { newThread: true, say: '这份报价单上 BC五层纸板 单价多少？', attach: ['scanPdf'] }, { newThread: true, say: '这份报价单上 BC五层纸板 单价多少？', attach: ['scanPdf'] }],
    expect: {}, check: (ctx, r) => [check('三次都答对', r.turns.length === 3 && r.turns.every((t) => /3\.21/.test(t.reply ?? '')), r.turns.map((t) => (t.reply ?? '').slice(0, 40)).join(' / '), 'C')] }),
  S({ id: 'FL7', title: '附件太大', look: '上传被拒，提示说清上限 10 MB；助手不假装看到了',
    turns: [{ uploadOnly: true, attach: [(ctx) => ctx.files.oversized()] }, '我刚传了一个 PDF，你看到了吗？'],
    expect: { reply: { not: [/看到了.*内容/] } },
    check: (ctx, r) => [
      check('超大文件被拒', r.uploads[0] && !r.uploads[0].ok, JSON.stringify(r.uploads[0]), 'B'),
      check('拒绝的话说清上限', /10\s*MB|10MB|10 兆/.test(r.uploads[0]?.message ?? ''), r.uploads[0]?.message ?? '', 'D'),
    ] }),
];

import {
  factoryName,
  splitFields,
  packInfo,
  totalParts,
  draftText,
  templateInfoFields,
  totalLine,
} from '../../shared/documents/index.js';
import { AppError } from '../core/index.js';
import type { BusinessForm } from '../../shared/documents/index.js';
import { MIN_PT, fitPt, lineMm, linesFor, textMm } from './measure.js';
import {
  CELL_SIDE_PAD_MM,
  CELL_TEXT_INSET_MM,
  RUNNING_PT,
  TERMS_GAP_MM,
  pageLayout,
  type PageLayout,
} from './paper.js';
// 版式规划：按纸张和字号排出抬头、信息格、明细表、备注和签字栏各占多高，每张放几行明细。Word、Excel 和页面预览用同一套。
const columnWeights: Record<string, number> = {
  index: 0.6,
  name: 2.1,
  specification: 3.1,
  unit: 0.8,
  quantity: 1.2,
  unitPrice: 1.6,
  amount: 1.5,
  notes: 1.7,
  productCode: 1.6,
  orderNumber: 2.2,
  customerOrderNumber: 1.7,
  dimensions: 1.8,
  material: 1.5,
  flute: 0.8,
};
/** 模板里没有列宽比例的列按这个比例 */
const DEFAULT_COLUMN_WEIGHT = 1.5;
export const columnAlign = (key?: string) =>
  key === 'index' || key === 'unit' || key === 'flute'
    ? 'center'
    : key === 'quantity' || key === 'amount' || key === 'unitPrice'
      ? 'right'
      : 'left';
/** 表格线：每行约 0.2 mm */
const BORDER_MM = 0.2;
/** 两张表的粗外框，各约 0.9 mm */
const OUTER_BORDER_MM = 0.9;
/** 模板没设字号时的正文字号 */
const DEFAULT_PT = 10;
/** 小字（日期、条款）比正文小 1.5 磅，最小 7.5 磅 */
const SMALL_PT = { below: 1.5, min: 7.5 } as const;
/** 明细列至少这么多才把标题放进抬头那一行，列少的标题单独占一行 */
const WIDE_MIN_COLUMNS = 5;
/** 有联次说明时右侧给竖排的联次留出的宽度 */
const COPY_STRIP_RESERVE_MM = 8;
/** 抬头左右两栏各占正文宽度的比例 */
const SIDE_SHARE = 0.36;
/** 公司名最小字号 */
const COMPANY_MIN_PT = 9;
/** 页眉页脚之外再给正文留的余量 */
const BODY_SAFETY_MM = 1.5;
/** 变高不到这个数不算“这一块太长” */
const NOTICEABLE_GROWTH_MM = 0.5;
/** 信息格每行几格：明细列够多、正文够宽放三格，再少一点放两格，其余一格 */
const infoPerRowRules = [
  { perRow: 3, minColumns: 6, minBodyMm: 200 },
  { perRow: 2, minColumns: 4, minBodyMm: 0 },
] as const;
/** 这段字在 minMm 高度里用基准字号往下能放下就用 minMm；放不下就按小一号字算出要多高。 */
type Grow = (text: string, widthMm: number, minMm: number) => number;
/** 各块规划都要用的：纸张、字号、正文宽、每列宽、拆好的字段和变高的算法 */
type Plan = {
  form: BusinessForm;
  page: PageLayout;
  size: number;
  small: number;
  bodyMm: number;
  keys: string[];
  colMm: number[];
  split: ReturnType<typeof splitFields>;
  grow: Grow;
  pad2: number;
};
const sum = (values: number[]) => values.reduce((n, v) => n + v, 0);
/** 备注格默认高度：最小字号写两行 */
const baseNotesMm = ({ page, pad2 }: Plan) => Math.max(page.rowMm, lineMm(MIN_PT) * 2 + pad2);

/**
 * 抬头一行：左边商标和公司名，中间标题（左右两栏等宽，标题在整张纸正中），右边单号和日期。
 * 我方联系人、地址放到页脚一行，预览/样张字样放到页眉，都不占正文高度，也不让行数随单据状态变化。
 */
function planHead({ form, page, bodyMm, size, small, split, pad2 }: Plan) {
  const showLogo = form.showLogo !== false;
  const logoColMm = showLogo ? page.logoColMm : 0,
    sideMm = bodyMm * SIDE_SHARE,
    companyRoom = sideMm - logoColMm - CELL_SIDE_PAD_MM * 2,
    companyPt = Math.max(
      COMPANY_MIN_PT,
      Math.min(
        page.companyMaxPt,
        Math.floor((companyRoom / textMm(form.companyName || factoryName, 1)) * 2) / 2,
      ),
    ),
    titlePt = page.titlePt,
    logoMm = showLogo ? page.logoMm : 0,
    headMm =
      pad2 +
      Math.max(
        logoMm,
        lineMm(companyPt),
        lineMm(titlePt) + 1,
        lineMm(size + 2) + (form.kind || split.date ? lineMm(small) : 0),
      );
  return { logoColMm, sideMm, companyPt, titlePt, headMm };
}

/** 在明细网格中选择最接近等宽信息格的边界；两种格式使用相同的合并范围。 */
function slotBoundaries(colMm: number[], bodyMm: number, perRow: number) {
  const boundaries = [0];
  for (let i = 1; i < perRow; i++) {
    let best = boundaries[i - 1] + 1,
      distance = Infinity;
    for (let c = best; c <= colMm.length - (perRow - i); c++) {
      const d = Math.abs(sum(colMm.slice(0, c)) - (bodyMm * i) / perRow);
      if (d < distance) {
        distance = d;
        best = c;
      }
    }
    boundaries.push(best);
  }
  return [...boundaries, colMm.length];
}

/** 信息格：「标签：内容」写在同一格，宽纸一行三格、窄纸两格；内容长的那一行变高，记下变高最多的是哪一格 */
function planInfo(plan: Plan) {
  const { form, page, keys, colMm, bodyMm, size, split, grow, pad2 } = plan;
  const perRow =
      infoPerRowRules.find((r) => keys.length >= r.minColumns && bodyMm >= r.minBodyMm)?.perRow ??
      1,
    infoKeys = form.kind
      ? templateInfoFields(
          form.kind,
          form.templateSnapshot?.hiddenFields,
          form.templateSnapshot?.companyAddress,
        )
      : split.info.map(([k]) => k),
    infoRows = packInfo(
      infoKeys.map((k) => [k, split.info.find(([name]) => name === k)?.[1] || '未填写']),
      perRow,
    ),
    slotColumns = slotBoundaries(colMm, bodyMm, perRow),
    infoBase = Math.max(page.infoMm, lineMm(size) + pad2),
    infoGrowth = { mm: 0, field: '' },
    infoRowMm = infoRows.map((items) => {
      let slot = 0;
      return Math.max(
        infoBase,
        ...items.map(({ k, v, slots }) => {
          const width = sum(colMm.slice(slotColumns[slot], slotColumns[slot + slots]));
          slot += slots;
          const h = grow(k + '：' + v, width - CELL_TEXT_INSET_MM, infoBase);
          if (h - infoBase > infoGrowth.mm) Object.assign(infoGrowth, { mm: h - infoBase, field: k });
          return h;
        }),
      );
    }),
    infoMm = sum(infoRowMm);
  return { perRow, infoKeys, infoRows, slotColumns, infoRowMm, infoMm, infoGrowth };
}

/** 页眉页脚伸进正文区的部分：算出正文能用的高度，和页眉、页脚那一行写什么 */
function planRunning({ form, page, bodyMm }: Plan, draft: string, ownText: string) {
  const headerLine = [form.headerText, draft].filter(Boolean).join('　'),
    footerLine = [ownText, form.footerText].filter(Boolean).join('　'),
    headIntrude = Math.max(
      0,
      page.headerDist +
        linesFor(
          [form.headerText, '测试样张 · 非正式'].filter(Boolean).join('　'),
          bodyMm,
          RUNNING_PT,
        ) *
          lineMm(RUNNING_PT) -
        page.top,
    ),
    footIntrude = Math.max(
      0,
      page.footerDist +
        linesFor(footerLine + '　第 1 张 / 共 1 张', bodyMm, RUNNING_PT) * lineMm(RUNNING_PT) -
        page.bottom,
    ),
    usable = page.height - page.top - page.bottom - headIntrude - footIntrude - BODY_SAFETY_MM;
  return { headerLine, footerLine, usable };
}

type Space = { usable: number; fixed: number; notesMm: number; infoGrowth: { mm: number; field: string } };
type Tallest = { row: number; field: string; mm: number };
/** 明细里最高的那一格：一张纸都放不下时告诉用户是哪一行哪一格 */
function tallestCell({ form, page, colMm, grow }: Plan): Tallest | null {
  let tallest: Tallest | null = null;
  form.rows.forEach((r, row) =>
    r.forEach((text, i) => {
      const h = grow(text, colMm[i] - CELL_TEXT_INSET_MM, page.rowMm);
      if (h > (tallest?.mm ?? page.rowMm)) tallest = { row: row + 1, field: form.headers[i], mm: h };
    }),
  );
  return tallest;
}

/** 变高之后一整张纸都放不下：哪一块变高得最多，就说是哪一块内容太长 */
function overflowError(plan: Plan, space: Space, tallest: Tallest | null) {
  const { form, page } = plan;
  const grown = [
    {
      mm: tallest ? tallest.mm - page.rowMm : 0,
      text: tallest ? `第 ${tallest.row} 行明细“${tallest.field}”` : '',
    },
    { mm: space.notesMm - baseNotesMm(plan), text: '的“备注”' },
    { mm: space.infoGrowth.mm, text: '的“' + space.infoGrowth.field + '”' },
  ].sort((a, b) => b.mm - a.mm)[0];
  const where = grown.mm > NOTICEABLE_GROWTH_MM ? grown.text : '';
  return new AppError(
    where
      ? `单据“${form.number}”${where}内容太长，一整张纸也放不下。请缩短内容或换更大的纸张后重新导出。`
      : `单据“${form.number}”的模板固定区域过高，放不下一行明细。请缩短公司资料、条款或单据内容，或换更大的纸张。`,
    400,
    'document_layout_overflow',
  );
}

/**
 * 明细行：按最高的那一格定行高，算每张放几行，剩下不够一行的高度均分给明细行（表格铺满）。
 * 一张纸一行都放不下就拒绝，说清是哪一块内容太长（明细的哪一格、备注、信息格里变高最多的那块）。
 */
function planRows(plan: Plan, space: Space) {
  const { usable, fixed } = space;
  const tallest = tallestCell(plan),
    rowNeed = tallest?.mm ?? plan.page.rowMm;
  const rowsPerPage = Math.floor((usable - fixed) / (rowNeed + BORDER_MM)),
    // 剩下不够一行的高度均分给明细行，表格铺满，签字栏下面不留大块空白。
    rowMm = Math.max(rowNeed, (usable - fixed) / rowsPerPage - BORDER_MM);
  if (rowsPerPage < 1) throw overflowError(plan, space, tallest);
  return { rowsPerPage, rowMm };
}

/** 纸张、字号、列宽这些各块都要用的基础量 */
function basePlan(form: BusinessForm): Plan {
  const page = pageLayout(form),
    size = form.fontSize || DEFAULT_PT,
    small = Math.max(SMALL_PT.min, size - SMALL_PT.below),
    copyLabels = (form.copyLabels || '').trim(),
    bodyMm = page.width - page.side * 2 - (copyLabels ? COPY_STRIP_RESERVE_MM : 0),
    keys = form.headers.map((_, i) => form.columnKeys?.[i] || ''),
    weights = keys.map((k) => columnWeights[k] || DEFAULT_COLUMN_WEIGHT),
    weightSum = sum(weights),
    colMm = weights.map((w) => (bodyMm * w) / weightSum),
    pad2 = page.padMm * 2;
  const grow: Grow = (text, widthMm, minMm) =>
    fitPt(text, widthMm, size, minMm - pad2) !== null
      ? minMm
      : Math.max(minMm, linesFor(text, widthMm, small) * lineMm(small) + pad2 + BORDER_MM);
  return { form, page, size, small, bodyMm, keys, colMm, split: splitFields(form), grow, pad2 };
}

/** 明细表最后一行的备注（标签占前几列）和明细表下面的条款 */
function planNotesAndTerms(plan: Plan) {
  const { form, page, colMm, bodyMm, small, split, grow } = plan;
  let noteSpan = 0;
  for (let acc = 0; noteSpan < colMm.length - 1 && acc < page.notesLabelMm; )
    acc += colMm[noteSpan++];
  noteSpan = Math.max(1, noteSpan);
  const notesW = sum(colMm.slice(noteSpan)) - CELL_SIDE_PAD_MM * 2,
    // 备注默认两行高，短文字可用较大字号；内容多就变高，不截断、不报错。
    notesMm = grow(form.notes || '', notesW, baseNotesMm(plan)),
    termText = split.terms.map(([k, v], i) => i + 1 + '. ' + k + '：' + v),
    termsMm = termText.length
      ? TERMS_GAP_MM + sum(termText.map((t) => linesFor(t, bodyMm, small) * lineMm(small)))
      : 0;
  return { noteSpan, notesW, notesMm, termText, termsMm };
}

/** 明细表的表头行和合计行 */
function planTable(plan: Plan, total: ReturnType<typeof totalParts>) {
  const { form, page, colMm, bodyMm, size, grow, pad2 } = plan;
  const headerRowMm = Math.max(
      page.rowMm,
      ...form.headers.map(
        (h, i) => linesFor(h, colMm[i] - CELL_TEXT_INSET_MM, size) * lineMm(size) + pad2,
      ),
    ),
    hasTotal = form.kind ? form.kind === 'purchase' : total !== null,
    plainTotalMm = Math.max(page.rowMm, lineMm(size) + pad2),
    totalMm = total
      ? grow(totalLine(total), bodyMm - CELL_TEXT_INSET_MM, plainTotalMm)
      : plainTotalMm;
  return { headerRowMm, hasTotal, totalMm };
}

/** 版式规划：Word、Excel 和页面预览用同一套尺寸，算出每张能放几行明细。 */
export function planLayout(form: BusinessForm) {
  const plan = basePlan(form),
    { page, keys, split } = plan,
    total = totalParts(form),
    draft = draftText(form),
    wide = keys.length >= WIDE_MIN_COLUMNS;
  const head = planHead(plan),
    ownText = split.own.map(([k, v]) => k + '：' + v).join('　'),
    info = planInfo(plan),
    table = planTable(plan, total),
    notes = planNotesAndTerms(plan),
    running = planRunning(plan, draft, ownText),
    extraHeadMm = wide ? 0 : lineMm(head.titlePt) + 2;
  const fixed =
    head.headMm +
    extraHeadMm +
    page.gapMm +
    (info.infoMm ? info.infoMm + page.gapMm : 0) +
    table.headerRowMm +
    (table.hasTotal ? table.totalMm : 0) +
    notes.notesMm +
    notes.termsMm +
    page.sigMm +
    BORDER_MM * (info.infoRowMm.length + 1 + (table.hasTotal ? 1 : 0) + 1) +
    OUTER_BORDER_MM * (info.infoRowMm.length ? 2 : 1);
  const rows = planRows(plan, {
    usable: running.usable,
    fixed,
    notesMm: notes.notesMm,
    infoGrowth: info.infoGrowth,
  });
  return {
    page,
    size: plan.size,
    small: plan.small,
    copyLabels: (form.copyLabels || '').trim(),
    showLogo: form.showLogo !== false,
    bodyMm: plan.bodyMm,
    keys,
    colMm: plan.colMm,
    ...split,
    total,
    draft,
    wide,
    ownText,
    extraHeadMm,
    ...head,
    ...info,
    ...table,
    ...notes,
    headerLine: running.headerLine,
    footerLine: running.footerLine,
    ...rows,
  };
}
/** 每张纸能放几行明细（同一模板下固定）。 */
export const documentRowsPerPage = (form: BusinessForm) => planLayout(form).rowsPerPage;

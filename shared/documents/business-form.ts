import type { DocumentFormat } from './business-export.js';
import type { DocumentColumn, DocumentPaper, DocumentKind, DocumentTemplate } from './document-templates.js';
/** 一张单据要印的内容：业务数据拼好、套上模板之后交给排版（server/documents/render.ts），预览接口原样回给页面。 */
export type BusinessForm = {
  title: string;
  companyName?: string;
  color?: string;
  fontSize?: number;
  templateId?: string;
  templateRevision?: number;
  defaultFormat?: DocumentFormat;
  kind?: DocumentKind;
  headerText?: string;
  footerText?: string;
  fontFamily?: string;
  orientation?: 'portrait' | 'landscape';
  density?: 'compact' | 'normal';
  paper?: DocumentPaper;
  /** 针式联单右侧竖排的联次说明，空串不印。 */
  copyLabels?: string;
  showLogo?: boolean;
  /** 每张纸固定的明细行数，由版式算出，预览和导出一致。 */
  rowsPerPage?: number;
  columnKeys?: DocumentColumn[];
  lineData?: Record<string, string>[];
  templateSnapshot?: DocumentTemplate;
  number: string;
  draft: boolean;
  sample?: boolean;
  fields: [string, string][];
  headers: string[];
  rows: string[][];
  notes: string;
  total?: string | null;
  signatures: string[];
};
/** 套上模板以后的单据内容：一定带模板编号、修订号和模板快照（导出记录要存） */
export type TemplatedForm = BusinessForm & Required<Pick<BusinessForm, 'templateId' | 'templateRevision' | 'templateSnapshot'>>;

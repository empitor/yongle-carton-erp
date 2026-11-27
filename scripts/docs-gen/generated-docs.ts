// docs/生成/ 下每份文档的位置和全文：npm run docs:gen（scripts/docs-gen.ts）照这里写文件，
// tests/checks/docs-generated.test.ts 照这里重新生成一遍和仓库里的比。新加一份生成的文档在这里登记。
import { MODULE_DOC, moduleDoc } from './module-doc.js';
import { SCHEMA_DOC, schemaDoc } from './schema-doc.js';

export const generatedDocs = () => [
  { path: SCHEMA_DOC, text: schemaDoc() },
  { path: MODULE_DOC, text: moduleDoc() },
];

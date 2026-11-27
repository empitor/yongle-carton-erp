// 生成 docs/生成/ 下的文档（表结构、模块表），不手改：npm run docs:gen。
// 每份从哪段代码生成、写到哪见 scripts/docs-gen/generated-docs.ts；tests/checks/docs-generated.test.ts 核对仓库里的是不是最新。
//
// - 要加载 server/ 的代码（建表、配置库规格）：先把本机数据目录、配置目录、业务库和备份位置都指到新建的临时目录再加载，
//   只在内存里建库，不碰任何数据文件；临时目录用完删掉。
// - 输出是确定的：同一份代码生成多少次都逐字节相同，换行一律 LF。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const sandbox = mkdtempSync(join(tmpdir(), 'erp-docs-gen-'));
process.env.LOCALAPPDATA = join(sandbox, 'localappdata');
process.env.ERP_CONFIG_DIR = join(sandbox, 'config');
process.env.DB_PATH = join(sandbox, 'data', 'erp.sqlite');
process.env.ERP_BACKUP_DIR = join(sandbox, 'backups');
try {
  const { generatedDocs } = await import('./docs-gen/generated-docs.js');
  for (const doc of generatedDocs()) {
    mkdirSync(dirname(doc.path), { recursive: true });
    writeFileSync(doc.path, doc.text);
    console.log('已生成：' + doc.path);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

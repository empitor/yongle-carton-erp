import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export async function extractAttachmentText(
  bytes: Buffer,
  name: string,
): Promise<{ text: string | null; notice: string; images: { page: number; data: string }[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'erp-chat-text-'));
  try {
    const path = join(dir, 'original');
    await writeFile(path, bytes, { flag: 'wx' });
    const result = await new Promise<string>((done, fail) =>
      execFile(
        process.execPath,
        [
          '--max-old-space-size=256',
          fileURLToPath(new URL('../import/parse-worker.mjs', import.meta.url)),
          path,
          extname(name).slice(1).toLowerCase(),
          'chat-attachment',
          dir,
          'chat-text-only',
        ],
        { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout) => {
          if (!stdout) return fail(error || Error('未提取到文字'));
          done(stdout);
        },
      ),
    );
    const data = JSON.parse(result);
    if (!data.ok) throw Error('未能提取有效文字');
    const blocks = data.result?.blocks || [],
      text = blocks
        .filter((b: any) => b.text?.trim())
        .map(
          (b: any) =>
            '[' +
            (b.ref?.sheet
              ? '工作表 ' + b.ref.sheet + ' 行' + b.ref.row
              : b.ref?.page
                ? '第' + b.ref.page + '页'
                : '段落' + (b.ref?.paragraph || '')) +
            '] ' +
            b.text,
        )
        .join('\n');
    const images: { page: number; data: string }[] = [];
    let imageBytes = 0;
    for (const p of data.result?.previews || []) {
      if (!/^chat-page-\d+\.jpg$/.test(p.name) || images.length >= 10)
        throw Error('预览图信息不合法');
      const b = await readFile(join(dir, p.name));
      imageBytes += b.length;
      if (imageBytes > 8 * 1024 * 1024) throw Error('扫描页转图过大');
      images.push({ page: p.page, data: 'data:image/jpeg;base64,' + b.toString('base64') });
    }
    if ((!text.trim() && !images.length) || text.length > 200000) throw Error('文字为空或过长');
    return {
      text: text || null,
      images,
      notice: images.length
        ? '已提取可用文字，并将' + images.length + '页扫描内容转为图片交给视觉模型；不执行OCR。'
        : '已准备兼容文字；不含文档内嵌图片、批注及完整排版，不执行公式或外链。',
    };
  } catch {
    return {
      text: null,
      images: [],
      notice:
        '未能提取兼容内容（文件复杂、加密、转图失败或超出15秒/10页限制）。原件仍保留；支持原文件的接口可尝试原文件模式，也可转换为图片。',
    };
  } finally {
    if (dirname(resolve(dir)) === resolve(tmpdir()))
      await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

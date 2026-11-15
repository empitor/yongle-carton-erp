// 附件图片的检查（server/core/attachment-validation.ts 的 checkImage）：解码出来的宽高和文件头一致、或者正好对调
// （手机竖拍带方向标记的照片）都收；别的不一致报“尺寸与文件头不一致”，解码不了报“图像内容损坏”。图都是脚本现造的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { validateAttachment } from '../server/core/attachment-validation.js';

/**
 * 现造一张 4×3 的 JPEG，在开头插一段 EXIF，方向标记写成“顺时针转 90°”（6），像手机竖拍的照片：
 * 文件头（SOF）写的是 4×3，图片库按方向标记转过来解码出 3×4。
 */
function rotatedJpeg() {
  const jpeg = createCanvas(4, 3).toBuffer('image/jpeg');
  // APP1 段：Exif 标识、大端 TIFF 头、一个 IFD 只有一项 Orientation(0x0112)=6
  const exif = Buffer.from(
    'ffe10022' + '457869660000' + '4d4d002a00000008' + '0001' + '011200030000000100060000' + '00000000',
    'hex',
  );
  return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
}
/** 一张 4×3 的 PNG（文件头 4×3） */
const png = () => createCanvas(4, 3).toBuffer('image/png');

test('手机竖拍的照片（方向标记转 90°，解码出来宽高对调）照常收', async () => {
  const checked = await validateAttachment(rotatedJpeg(), '虚构竖拍.jpg');
  assert.equal(checked.kind, 'image');
});

/** 假的图片库：解码出来固定是这个宽高 */
const decodesTo = (width: number, height: number) => async () => async () => ({ width, height });

test('解码出来的宽高和文件头正好对调：照常收，记的是文件头的宽高', async () => {
  const checked = await validateAttachment(png(), '虚构对调.png', decodesTo(3, 4));
  assert.deepEqual([checked.kind, checked.width, checked.height], ['image', 4, 3]);
});

test('解码出来的尺寸和文件头既不一致也不是对调：报“尺寸与文件头不一致”，不说成内容损坏', async () => {
  await assert.rejects(validateAttachment(png(), '虚构尺寸不符.png', decodesTo(4, 4)), /图片实际尺寸与文件头不一致/);
});

test('只有解码这一步失败才算内容损坏；图片库加载失败是服务器的问题，原样往上抛', async () => {
  const broken = async () => async () => {
    throw new Error('虚构解码失败');
  };
  await assert.rejects(validateAttachment(png(), '虚构坏图.png', broken), /图像内容损坏/);
  const unloadable = async () => {
    throw new Error('虚构图片库加载失败');
  };
  await assert.rejects(validateAttachment(png(), '虚构.png', unloadable), (e: unknown) => e instanceof Error && e.message === '虚构图片库加载失败');
});

test('文件头读得出、内容解码不了的图片：报“图像内容损坏”', async () => {
  // 留下签名和 IHDR（文件头读得出 4×3），后面的数据块截掉
  await assert.rejects(validateAttachment(png().subarray(0, 40), '虚构截断.png'), /图像内容损坏/);
});

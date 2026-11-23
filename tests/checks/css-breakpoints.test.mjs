// “多窄算手机”只有 700 一个标准：样式检查（stylelint.config.mjs，npm run lint:css）拦下别的手机断点，放过别的用途的断点。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import stylelint from 'stylelint';
import config from '../../stylelint.config.mjs';

const RULE = 'media-feature-name-value-allowed-list';

/** 一段样式里被断点规则拦下的写法 */
async function rejected(media) {
  const { results } = await stylelint.lint({ code: `@media ${media} { .a { display: none; } }`, config });
  return results.flatMap((r) => r.warnings.filter((w) => w.rule === RULE).map((w) => w.text));
}

test('手机断点只许 700：760 这类第二个标准被拦，提示里写明该用哪个', async () => {
  for (const media of [
    '(max-width: 760px)',
    '(min-width: 761px)',
    '(width <= 760px)',
    '(MAX-WIDTH: 760px)',
    '(Min-Width: 761px)',
    '(max-device-width: 760px)',
    '(device-width <= 760px)',
  ]) {
    const texts = await rejected(media);
    assert.equal(texts.length, 1, media);
    assert.match(texts[0] ?? '', /max-width: 700px/);
  }
});

test('700 本身、更窄的手机、窄屏电脑和大屏多一栏的断点放行', async () => {
  for (const media of [
    '(max-width: 700px)',
    '(MAX-WIDTH: 700px)',
    '(min-width: 701px)',
    '(max-width: 480px)',
    '(max-width: 1023px)',
    '(min-width: 1200px)',
    '(prefers-reduced-motion: reduce)',
  ])
    assert.deepEqual(await rejected(media), [], media);
});

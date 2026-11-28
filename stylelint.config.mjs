// 样式检查（npm run lint:css）：管两件事——颜色、字号、圆角、层级不写死，只引用变量；“多窄算手机”只有 700 一个标准。
// 变量只在 src/ui/tokens.css 定义（字号、圆角的档位见 docs/界面/样式和主题.md）；别的风格规则不开。
// - 颜色：tokens.css 以外不许出现色值（#hex、rgb()/hsl() 这类、颜色名），box-shadow、border、渐变里的也算；
//   用变量调出来的 color-mix(in srgb, var(--a) 20%, transparent) 不算写死。
// - 字号、圆角、层级：整个值只能是 var(--…)；transparent、currentColor、inherit、0、none、auto 这类关键字放行。
// - 窗口宽度断点（@media，样例在 tests/css-breakpoints.test.mjs）：手机是 max-width: 700px（反过来 min-width: 701px），
//   和 src/ui/phone.ts 的手机判断同一个数。701～899 之间不许再立断点（那就是第二个“算手机”的标准）；
//   700 以下的（600、480 这类更窄的手机再收一档）和 900 以上的（窄屏电脑、大屏多一栏）是别的用途，放行。
//   只认 px 的 max-width、min-width 写法；width <= 760px 这种范围写法不许用，免得绕过。容器查询（@container）量的是
//   组件自己的宽度，不归这条管。
const keywords = ['transparent', 'currentColor', 'currentcolor', 'inherit', 'initial', 'unset', '0', 'none', 'auto'];
const tokens = 'src/ui/tokens.css';
const desktopWidth = /^(9\d\d|[1-9]\d{3})px$/;
const breakpointMessage = (name, value) =>
  '断点“' + name + ': ' + value + '”不许用：手机只有 max-width: 700px（min-width: 701px）一个标准，' +
  '701～899 之间不立断点，范围写法改成 max-width/min-width（见 docs/界面/样式和主题.md“页签、手机、质感”）';

export default {
  plugins: ['stylelint-declaration-strict-value'],
  rules: {
    'color-no-hex': [true, { message: (hex) => '颜色写死了（' + hex + '）：在 ' + tokens + ' 定义变量，这里只引用' }],
    'color-named': ['never', { message: (color) => '颜色写死了（' + color + '）：在 ' + tokens + ' 定义变量，这里只引用' }],
    'function-disallowed-list': [
      ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color'],
      { message: (name) => '颜色写死了（' + name + '()）：在 ' + tokens + ' 定义变量，这里只引用' },
    ],
    'scale-unlimited/declaration-strict-value': [
      ['font-size', '/^(?!--).*radius$/', 'z-index'],
      {
        expandShorthand: true,
        ignoreFunctions: false,
        ignoreValues: keywords,
        message: '${property} 写死了“${value}”：字号、圆角、层级只引用 ' + tokens + ' 里的变量',
      },
    ],
    'media-feature-name-value-allowed-list': [
      // 特性名不分大小写、device-width 一系也算（MAX-WIDTH、max-device-width 不能绕过）
      {
        '/^max-(device-)?width$/i': [/^([1-6]\d\d|700)px$/, desktopWidth],
        '/^min-(device-)?width$/i': ['701px', desktopWidth],
        '/^(device-)?width$/i': [],
      },
      { message: breakpointMessage },
    ],
  },
  overrides: [
    {
      // 变量定义在这里，色值只许出现在这一份
      files: [tokens],
      rules: { 'color-no-hex': null, 'color-named': null, 'function-disallowed-list': null },
    },
  ],
};

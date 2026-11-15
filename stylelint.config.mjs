// 样式检查（npm run lint:css）：只管一件事——颜色、字号、圆角、层级不写死，只引用变量。
// 变量只在 src/ui/tokens.css 定义（字号、圆角的档位见 AGENTS.md“界面”、docs/界面规范.md）；别的风格规则不开。
// - 颜色：tokens.css 以外不许出现色值（#hex、rgb()/hsl() 这类、颜色名），box-shadow、border、渐变里的也算；
//   用变量调出来的 color-mix(in srgb, var(--a) 20%, transparent) 不算写死。
// - 字号、圆角、层级：整个值只能是 var(--…)；transparent、currentColor、inherit、0、none、auto 这类关键字放行。
const keywords = ['transparent', 'currentColor', 'currentcolor', 'inherit', 'initial', 'unset', '0', 'none', 'auto'];
const tokens = 'src/ui/tokens.css';

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
  },
  overrides: [
    {
      // 变量定义在这里，色值只许出现在这一份
      files: [tokens],
      rules: { 'color-no-hex': null, 'color-named': null, 'function-disallowed-list': null },
    },
  ],
};

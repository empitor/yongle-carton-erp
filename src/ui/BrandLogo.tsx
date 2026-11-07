/**
 * 甬勒包装商标：Y 和 L，L 的转角是纸板折痕，折过来的一段颜色深一档。
 * 所有斜边都和 Y 的右臂平行。改这里要同步 public/favicon.svg、docs/brand/ 和单据里用的
 * server/documents/brand-logo.ts。
 */
export default function BrandLogo({ size }: { size: number }) {
  return (
    <svg
      className="brand-logo"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="甬勒包装商标"
    >
      <path fill="var(--teal)" d="M2 8H22L34 28 46 8H66L42 48V92H26V48Z" />
      <path fill="var(--kraft)" d="M48 48 64 21.3V73.2L48 89.2Z" />
      <path fill="var(--kraft-deep)" d="M66.8 76H98L88.4 92H50.8Z" />
    </svg>
  );
}

/*
 * 小甬、小勒和互动效果的画法（YlSpirits 用）。只画，不动：分层的类名由 YlSpirits 的属性和 spirits*.css 驱动。
 */

/** 小甬（Y） */
export function YongFigure() {
  return (
    <g className="yl-y-pose">
      <g className="yl-y-enter">
      <g className="yl-y-act">
        <g className="yl-y-breathe">
          <g className="yl-y-body">
            <path d="M24 46H46V98H24Z" />
            <path className="yl-arm-l" d="M4 14H25L35 31V50H24Z" />
            <path className="yl-arm-r" d="M66 14H45L35 31V50H46Z" />
          </g>
          <g className="yl-face yl-face-y">
          <g className="yl-eyes yl-eyes-y">
            <circle className="yl-white" cx="29" cy="55" r="4.4" />
            <circle className="yl-white" cx="41" cy="55" r="4.4" />
            <g className="yl-look">
              <g className="yl-pupils yl-pupils-y">
                <circle className="yl-pupil" cx="29" cy="55.4" r="2.64" />
                <circle className="yl-pupil" cx="41" cy="55.4" r="2.64" />
                <circle className="yl-glint" cx="29.9" cy="54.1" r=".88" />
                <circle className="yl-glint" cx="41.9" cy="54.1" r=".88" />
              </g>
            </g>
          </g>
          <g className="yl-cheeks">
            <ellipse cx="27" cy="63" rx="3" ry="1.8" />
            <ellipse cx="43" cy="63" rx="3" ry="1.8" />
          </g>
          <path className="yl-smile yl-smile-y" d="M31.4 63Q35 67.3 38.6 63" />
          <path className="yl-open yl-open-y" d="M31 62.4Q35 61.6 39 62.4Q38.6 68.4 35 68.4Q31.4 68.4 31 62.4Z" />
          </g>
        </g>
      </g>
      </g>
    </g>
  );
}

/** 小勒（L）：脚托着一只小纸箱，紫色小星代表 AI */
export function LeFigure() {
  return (
    <g className="yl-l-pose">
      <g className="yl-l-enter">
      <g className="yl-l-act">
        <g className="yl-l-breathe">
          <path className="yl-l-stem" d="M52 56 73 21V76L52 95Z" />
          <g className="yl-face yl-face-l">
          <g className="yl-eyes yl-eyes-l">
            <circle className="yl-white" cx="57.5" cy="56" r="4.4" />
            <circle className="yl-white" cx="68.5" cy="56" r="4.4" />
            <g className="yl-look">
              <g className="yl-pupils yl-pupils-l">
                <circle className="yl-pupil" cx="57.5" cy="56.4" r="2.64" />
                <circle className="yl-pupil" cx="68.5" cy="56.4" r="2.64" />
                <circle className="yl-glint" cx="58.4" cy="55.1" r=".88" />
                <circle className="yl-glint" cx="69.4" cy="55.1" r=".88" />
              </g>
            </g>
          </g>
          <g className="yl-cheeks">
            <ellipse cx="55.5" cy="64" rx="3" ry="1.8" />
            <ellipse cx="70.5" cy="64" rx="3" ry="1.8" />
          </g>
          <path className="yl-smile yl-smile-l" d="M59.4 64Q63 68.3 66.6 64" />
          <path className="yl-open yl-open-l" d="M59 63.4Q63 62.6 67 63.4Q66.6 69.4 63 69.4Q59.4 69.4 59 63.4Z" />
          </g>
          {/* 脚和它托着的东西一起动，折痕就是转轴 */}
          <g className="yl-foot">
            <path className="yl-foot-board" d="M77 79H103L93 98H56Z" />
            <g className="yl-cargo">
              <g className="yl-box">
                <rect className="yl-box-body" x="80" y="58" width="20" height="18" rx="1.6" />
                <rect className="yl-box-tape" x="87.6" y="58" width="4.8" height="7.6" />
              </g>
              <g className="yl-star">
                <path d="M90 33.9Q91.2 40.8 98.1 42Q91.2 43.2 90 50.1Q88.8 43.2 81.9 42Q88.8 40.8 90 33.9Z" />
                <circle cx="99.5" cy="35.7" r="1.5" />
              </g>
            </g>
          </g>
        </g>
      </g>
      </g>
    </g>
  );
}

/** 互动时才出现的效果 */
export function SceneEffects() {
  return (
    <>
      <g className="yl-dots">
        <circle cx="52" cy="14" r="1.8" />
        <circle cx="58" cy="10" r="2.1" />
        <circle cx="65" cy="7" r="2.4" />
      </g>
      <path
        className="yl-heart"
        d="M62 12.5C59.4 10.2 55.5 8.4 55.5 5.1C55.5 2.7 58.9 1.7 62 4.6C65.1 1.7 68.5 2.7 68.5 5.1C68.5 8.4 64.6 10.2 62 12.5Z"
      />
      <g className="yl-burst">
        <path d="M70 7V2M77 10 81 7M63 10 59 7M79 16H84M61 16H56" />
        <circle cx="70" cy="14" r="2.4" />
      </g>
    </>
  );
}

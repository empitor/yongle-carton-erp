import { useId } from 'react';
/** Original inline vector: kraft-paper body, folded lid and a mint-green packing seal. */
export default function CartonSpirit() {
  const id = useId().replace(/:/g, '');
  return (
    <svg
      className="ga-spirit"
      viewBox="0 0 100 112"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient
          id={id + 'body'}
          x1="25"
          y1="34"
          x2="66"
          y2="95"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#f1d7a8" />
          <stop offset="1" stopColor="#d8b47c" />
        </linearGradient>
        <linearGradient
          id={id + 'side'}
          x1="74"
          y1="41"
          x2="88"
          y2="87"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#c5a06b" />
          <stop offset="1" stopColor="#a9804d" />
        </linearGradient>
        <linearGradient
          id={id + 'seal'}
          x1="43"
          y1="26"
          x2="56"
          y2="56"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#8cdbc2" />
          <stop offset="1" stopColor="#4eae95" />
        </linearGradient>
      </defs>
      <ellipse
        className="ga-spirit-shadow"
        cx="51"
        cy="102"
        rx="28"
        ry="4"
        fill="#061e1c"
        opacity=".22"
      />
      <g className="ga-spirit-body">
        <path
          className="ga-spirit-hand"
          d="M19 68C9 61 6 53 12 49C16 47 19 53 24 55"
          fill="#e2c18c"
          stroke="#99744c"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <path
          d="M82 66C90 63 94 67 92 72C91 76 86 78 81 77"
          fill="#d2ae76"
          stroke="#99744c"
          strokeWidth="1.5"
        />
        <path
          d="M32 90L30 99C31 104 40 104 43 100L45 92M64 91L64 100C67 104 76 102 76 98L74 90"
          fill="#72c9ad"
          stroke="#397f6c"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M25 37L46 25C49 23 52 23 56 25L82 38L64 51L25 43Z"
          fill="#f0d7ad"
          stroke="#aa8253"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path
          d="M73 42L84 39L84 83Q84 89 78 92L68 96L67 52Z"
          fill={'url(#' + id + 'side)'}
          stroke="#a37d50"
          strokeWidth="1.4"
        />
        <path
          d="M21 44Q21 38 27 39L69 45Q76 46 76 53L76 87Q76 96 67 96L29 91Q21 90 21 82Z"
          fill={'url(#' + id + 'body)'}
          stroke="#aa8253"
          strokeWidth="1.6"
        />
        <path
          d="M25 45L65 50"
          stroke="#fff2d7"
          strokeWidth="2"
          strokeLinecap="round"
          opacity=".65"
        />
        <path
          d="M47 26L60 32L49 40L49 53L44 50L40 52L40 39Z"
          fill={'url(#' + id + 'seal)'}
          stroke="#4e9c84"
          strokeWidth="1"
          strokeLinejoin="round"
        />
        <path
          d="M21 39L12 30Q11 27 15 26L40 31L47 39L31 44Q25 45 21 39Z"
          fill="#efdab6"
          stroke="#aa8253"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path
          d="M53 30L67 19Q70 17 73 20L89 31Q92 34 88 36L75 42Z"
          fill="#e6c797"
          stroke="#aa8253"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <g className="ga-spirit-eyes" fill="#29493e">
          <ellipse cx="36" cy="64" rx="4.3" ry="5.4" />
          <ellipse cx="61" cy="67" rx="4.3" ry="5.4" />
          <circle cx="37.3" cy="62" r="1.35" fill="#fffbed" />
          <circle cx="62.3" cy="65" r="1.35" fill="#fffbed" />
        </g>
        <ellipse cx="29" cy="73" rx="5" ry="2.5" fill="#d88f77" opacity=".52" />
        <ellipse cx="67" cy="76" rx="4.5" ry="2.4" fill="#d88f77" opacity=".52" />
        <path d="M43 76Q47 82 52 77" stroke="#526744" strokeWidth="2" strokeLinecap="round" />
        <path
          d="M60 86L69 87M62 89L69 90"
          stroke="#997c52"
          strokeWidth="1.2"
          strokeLinecap="round"
          opacity=".65"
        />
        <path d="M22 82L26 83" stroke="#b18f5e" strokeWidth="1.2" strokeLinecap="round" />
      </g>
    </svg>
  );
}

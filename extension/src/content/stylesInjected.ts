/**
 * Injected stylesheet for themes + distraction reduction. Kept as TS string so the
 * content bundle stays self-contained (no separate CSS asset required by manifest).
 */

export const BASE_ATTR = "data-neuro-inclusive";

export function buildThemeCss(
  fontSizePx: number,
  lineHeight: number,
  letterSpacingEm: number,
  theme: string,
  readability: boolean
): string {
  const read = readability
    ? `
    main, article, [role="main"], .neuro-inclusive-main {
      max-width: 68ch !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }
  `
    : "";

  return `
    html[${BASE_ATTR}] {
      font-size: ${fontSizePx}px !important;
      line-height: ${lineHeight} !important;
      letter-spacing: ${letterSpacingEm}em !important;
    }
    html[${BASE_ATTR}].theme-default body {
      background: #fafafa !important;
      color: #1a1a1a !important;
    }
    html[${BASE_ATTR}].theme-dark body {
      background: #121212 !important;
      color: #e8e8e8 !important;
    }
    html[${BASE_ATTR}].theme-sepia body {
      background: #f4ecd8 !important;
      color: #2c2416 !important;
    }
    html[${BASE_ATTR}].theme-dyslexia {
      font-family: "OpenDyslexic", "Comic Sans MS", sans-serif !important;
    }
    html[${BASE_ATTR}].theme-dyslexia body {
      background: #fffef6 !important;
      color: #1a1a1a !important;
    }
    html[${BASE_ATTR}].theme-autism body {
      background: #eceff1 !important;
      color: #37474f !important;
    }
    html[${BASE_ATTR}].theme-autism a {
      color: #455a64 !important;
    }
    html[${BASE_ATTR}] [data-neuro-inclusive-difficult="1"] {
      outline: 2px solid rgba(255, 170, 0, 0.35) !important;
      outline-offset: 2px !important;
      background-image: linear-gradient(
        90deg,
        rgba(255, 214, 102, 0.12),
        rgba(255, 214, 102, 0)
      ) !important;
    }
    ${read}
  `;
}

/** Heuristic selectors for common distractions — best-effort for hackathon demo */
export const DISTRACTION_CSS = `
  html[data-neuro-inclusive-distract] iframe[src*="doubleclick"],
  html[data-neuro-inclusive-distract] iframe[src*="googlesyndication"],
  html[data-neuro-inclusive-distract] [class*="advertisement"],
  html[data-neuro-inclusive-distract] [class*="advert"],
  html[data-neuro-inclusive-distract] [id*="google_ads"],
  html[data-neuro-inclusive-distract] [id*="ad-container"] {
    filter: blur(6px) brightness(0.7) !important;
    opacity: 0.35 !important;
    pointer-events: none !important;
    max-height: 120px !important;
    overflow: hidden !important;
  }
  html[data-neuro-inclusive-distract] video[autoplay] {
    filter: blur(4px) !important;
    opacity: 0.4 !important;
  }
`;

import type { SVGProps } from "react";

/**
 * Minimal single-path icons for the theme toggle — deliberately not the
 * ☀/☾ unicode glyphs, which render inconsistently across platform emoji
 * fonts (weight, baseline, even color on some systems) in a way a hand-
 * drawn SVG at a fixed stroke width doesn't.
 */

export function SunIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 1.4v1.6M8 13v1.6M14.6 8H13M3 8H1.4M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5 3.4 3.4" />
    </svg>
  );
}

export function MoonIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M13.8 9.9A6 6 0 1 1 6.1 2.2a5 5 0 0 0 7.7 7.7Z"
        fill="currentColor"
      />
    </svg>
  );
}

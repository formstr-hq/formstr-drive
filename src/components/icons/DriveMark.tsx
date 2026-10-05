// In-app Form* Drive mark. Unlike the favicon/launcher icon (fixed ink plate), this one is
// plate-less and follows the light/dark toggle: files stay ember-orange, the pocket takes
// --color-logo-bg (ink in light mode, white in dark mode).
export function DriveMark({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="10 10 80 82"
      className={className}
      role="img"
      aria-label="Form* Drive"
    >
      <g transform="rotate(-24 50 78)">
        <rect x="34" y="18" width="32" height="46" rx="4" fill="#9A2E14" />
        <path d="M40 26H60M40 34H60M40 42H52" stroke="#BF3315" strokeWidth="3" strokeLinecap="round" fill="none" />
      </g>
      <g transform="rotate(24 50 78)">
        <rect x="34" y="18" width="32" height="46" rx="4" fill="#D63E18" />
        <path d="M40 26H60M40 34H60M40 42H52" stroke="#FF7A56" strokeWidth="3" strokeLinecap="round" fill="none" />
      </g>
      <rect x="34" y="14" width="32" height="46" rx="4" fill="#FF5733" />
      <path d="M50 21V33M44.8 24L55.2 30M55.2 24L44.8 30" stroke="#FFFFFF" strokeWidth="3.2" strokeLinecap="round" fill="none" />
      <path d="M40 40H60" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" fill="none" />
      <rect x="14" y="48" width="72" height="42" rx="8" style={{ fill: "var(--color-logo-bg)" }} />
    </svg>
  );
}

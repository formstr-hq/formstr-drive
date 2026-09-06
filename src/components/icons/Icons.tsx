export function FolderIcon({ className }: { className?: string } = {}) {
  return (
    <svg viewBox="0 0 24 16" fill="none" aria-hidden="true" className={className}>
      <path
        d="M2 2.5C2 1.67 2.67 1 3.5 1H8.7C9.14 1 9.56 1.2 9.84 1.54L11.18 3.2C11.47 3.56 11.9 3.76 12.36 3.76H20.5C21.33 3.76 22 4.43 22 5.26V13.5C22 14.33 21.33 15 20.5 15H3.5C2.67 15 2 14.33 2 13.5V2.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function HomeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.4 1.2 7v7.1c0 .5.4.9.9.9H6v-5h4v5h3.9c.5 0 .9-.4.9-.9V7L8 1.4Z" />
    </svg>
  );
}

export function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`folder-chevron${expanded ? " is-expanded" : ""}`}
      aria-hidden="true"
    >
      <path d="M4 2.5 8 6l-4 3.5" />
    </svg>
  );
}

export function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function GridViewIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
      <rect x="1" y="1" width="6" height="6" rx="1" />
      <rect x="9" y="1" width="6" height="6" rx="1" />
      <rect x="1" y="9" width="6" height="6" rx="1" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  );
}

export function ListViewIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
      <rect x="1" y="2" width="14" height="2" rx="1" />
      <rect x="1" y="7" width="14" height="2" rx="1" />
      <rect x="1" y="12" width="14" height="2" rx="1" />
    </svg>
  );
}

export function PreviewEyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" style={{ pointerEvents: "none" }}>
      <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
    </svg>
  );
}

export function ShareIcon({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      style={{ pointerEvents: "none" }}
    >
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M8.3 10.7 15.7 6.6M8.3 13.3l7.4 4.1" />
    </svg>
  );
}

export function BunkerLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M10.25 13.75 13.75 10.25M8 15.5H6.5a3 3 0 1 1 0-6H8m8 6h1.5a3 3 0 1 0 0-6H16"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

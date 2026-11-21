export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <span className="wordmark">
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect x="1" y="1" width="22" height="22" rx="8" fill="currentColor" />
        <rect x="7.4" y="9" width="2.6" height="6" rx="1.3" fill="var(--color-canvas)" />
        <rect x="14" y="9" width="2.6" height="6" rx="1.3" fill="var(--color-canvas)" />
      </svg>
      <span>terabot</span>
    </span>
  );
}

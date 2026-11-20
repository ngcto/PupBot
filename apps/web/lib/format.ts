const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);

  if (date >= startOfToday) return `Today ${timeFormat.format(date)}`;
  if (date >= startOfYesterday) return `Yesterday ${timeFormat.format(date)}`;
  return `${dateFormat.format(date)} ${timeFormat.format(date)}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes}B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)}kB`;
  return `${(bytes / 1_000_000).toFixed(1)}MB`;
}

export function previewText(text: string, max = 60): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

export function iconLabel(name: string): string {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

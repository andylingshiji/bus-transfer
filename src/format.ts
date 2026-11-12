export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function hktClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("zh-HK", {
    timeZone: "Asia/Hong_Kong",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

export function minutesLabel(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms)) return "";
  if (ms < 0) return "已過";
  const min = Math.round(ms / 60000);
  if (min <= 0) return "1 分鐘內";
  return `${min} 分鐘`;
}

export function opName(op: "KMB" | "LWB" | "CTB" | "KMBLWB"): string {
  if (op === "LWB") return "龍運";
  if (op === "CTB") return "城巴";
  if (op === "KMB") return "九巴";
  return "九巴／龍運";
}

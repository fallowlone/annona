/**
 * Escape text for Telegram HTML parse mode. Covers tag-body content (& < >) and
 * the double-quote so the same helper is safe inside a `"`-quoted attribute
 * value (e.g. `<a href="...">`) even if that value ever carries dynamic data.
 */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

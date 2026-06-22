import type { Intent } from "../types";

/** Split a remainder like "плов, борщ" into trimmed, non-empty dish names. */
function names(rest: string): string[] {
  return rest
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ADD_CUSTOM = [/^добавь\s+блюдо\s+(.+)$/i, /^новое\s+блюдо\s+(.+)$/i, /^\/recipe\s+(.+)$/i];
const ADD = [/^добавь\s+(.+)$/i, /^\+\s*(.+)$/i];
const REMOVE = [/^убери\s+(.+)$/i, /^удали\s+(.+)$/i, /^минус\s+(.+)$/i, /^-\s*(.+)$/i];
const SCALE = /^(.+?)\s+на\s+(\d+)\s*порц/i;

/**
 * Deterministic keyword prefilter run before the LLM intent router. Returns an
 * Intent for the explicit edit/custom/scale verbs, or null to defer to
 * `classifyIntent`. Pure; longer prefixes (e.g. "добавь блюдо") win over shorter.
 */
export function routeMessage(text: string): Intent | null {
  const t = text.trim();
  if (t === "") return null;

  for (const re of ADD_CUSTOM) {
    const m = t.match(re);
    if (m) {
      const n = names(m[1]!);
      return n.length ? { kind: "add_custom_dish", dishNames: n } : null;
    }
  }

  for (const re of ADD) {
    const m = t.match(re);
    if (m) {
      const n = names(m[1]!);
      return n.length ? { kind: "add_dishes", dishNames: n } : null;
    }
  }

  for (const re of REMOVE) {
    const m = t.match(re);
    if (m) {
      const n = names(m[1]!);
      return n.length ? { kind: "remove_dishes", dishNames: n } : null;
    }
  }

  const s = t.match(SCALE);
  if (s) {
    const name = s[1]!.trim();
    const target = Number(s[2]);
    if (name && target > 0) {
      return { kind: "scale_dish", dishNames: [name], targetServings: target };
    }
  }

  return null;
}

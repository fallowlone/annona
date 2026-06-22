import type { Intent } from "../types";

// Bounds on free-text input so absurd values never reach scaling math or the LLM.
const MAX_SERVINGS = 100;
const MAX_DISH_NAME_LEN = 120;

/** Split a remainder into trimmed, non-empty, length-capped dish names. */
function names(rest: string): string[] {
  return rest
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= MAX_DISH_NAME_LEN);
}

const ADD_CUSTOM = [/^добавь\s+блюдо\s+(.+)$/i, /^новое\s+блюдо\s+(.+)$/i, /^\/recipe\s+(.+)$/i];
const ADD = [/^добавь\s+(.+)$/i, /^\+\s*(.+)$/i];
const SHOW_PANTRY = [/^\/pantry$/i, /^что\s+(есть\s+)?дома\??$/i];
const ADD_PANTRY = [/^у\s+меня\s+есть\s+(.+)$/i, /^есть\s+дома\s+(.+)$/i, /^дома\s+есть\s+(.+)$/i, /^\/pantry\s+(.+)$/i];
const REMOVE_PANTRY = [/^закончил(?:ся|ась|ись)\s+(.+)$/i, /^убери\s+из\s+дома\s+(.+)$/i];
// "удали блюдо X" deletes from the catalogue — checked before the week-removal verbs.
const DELETE_CUSTOM = [/^удали\s+блюдо\s+(.+)$/i, /^убери\s+блюдо\s+(.+)$/i, /^\/delrecipe\s+(.+)$/i];
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

  for (const re of SHOW_PANTRY) {
    if (re.test(t)) return { kind: "show_pantry", dishNames: [] };
  }

  for (const re of ADD_PANTRY) {
    const m = t.match(re);
    if (m) {
      const n = names(m[1]!);
      return n.length ? { kind: "add_pantry", dishNames: n } : null;
    }
  }

  for (const re of REMOVE_PANTRY) {
    const m = t.match(re);
    if (m) {
      const n = names(m[1]!);
      return n.length ? { kind: "remove_pantry", dishNames: n } : null;
    }
  }

  for (const re of DELETE_CUSTOM) {
    const m = t.match(re);
    if (m) {
      const n = names(m[1]!);
      return n.length ? { kind: "delete_dish", dishNames: n } : null;
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
    if (name && name.length <= MAX_DISH_NAME_LEN && target > 0 && target <= MAX_SERVINGS) {
      return { kind: "scale_dish", dishNames: [name], targetServings: target };
    }
  }

  return null;
}

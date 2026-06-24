import type { Intent } from "../types";

// Bounds on free-text input so absurd values never reach scaling math or the LLM.
const MAX_SERVINGS = 100;
const MAX_DISH_NAME_LEN = 120;

/** Split a comma list into trimmed, non-empty, length-capped names. Canonical
 *  splitter shared with the command handlers so caps/rules can't drift. */
export function names(rest: string): string[] {
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

// Navigation intents whose handlers need NO LLM (menu/list read the cache, help
// is static). Anchored to the whole message so they never swallow a dish list or
// an edit verb — and routing them here skips the `classifyIntent` LLM call.
const SHOW_MENU = /^(меню|меню\s+(на\s+)?недел[юи]|покажи\s+меню|\/menu)\??$/i;
const SHOW_LIST = /^(список(\s+покупок)?|покупки|что\s+(купить|покупать)|\/list)\??$/i;
const SUGGEST = /^(что\s+(можно\s+)?(при)?готовить|что\s+вкусного|что\s+выгодно(\s+приготовить)?|выгодно|идеи|посоветуй|\/digest|дайджест)\??$/i;
const HELP = /^(\/help|\/start|помощь|помоги|привет|здравствуй(те)?|хай|hi|hello|start|что\s+ты\s+умеешь|как\s+пользоваться)\??$/i;

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

  // No-LLM navigation intents (checked last so the verb/scale rules win first).
  if (SHOW_MENU.test(t)) return { kind: "show_menu", dishNames: [] };
  if (SHOW_LIST.test(t)) return { kind: "show_list", dishNames: [] };
  if (SUGGEST.test(t)) return { kind: "suggest", dishNames: [] };
  if (HELP.test(t)) return { kind: "help", dishNames: [] };

  return null;
}

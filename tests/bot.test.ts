import { test, expect } from "bun:test";
import { createBot } from "../src/bot/bot";
import { openDb } from "../src/db/db";
import { insertDish, listDishes } from "../src/recipes/recipeStore";
import { getSelection } from "../src/recipes/selectionStore";
import { isoWeek } from "../src/util/week";
import type { Dish } from "../src/types";
import type { Matcher } from "../src/matcher";
import type { Llm } from "../src/llm/llm";

const USER = 111;

const plov: Dish = {
  nameRu: "Плов", nameUa: null, nameDe: null, cuisine: "ru", course: "second",
  keepsDays: 3, tags: [], servings: 4, ingredients: [{ canonical: "рис", qty: 1, unit: "кг" }],
};
const shakshuka: Dish = {
  nameRu: "Шакшука", nameUa: null, nameDe: null, cuisine: "il", course: "second",
  keepsDays: 1, tags: [], servings: 4, ingredients: [{ canonical: "яйца", qty: 4, unit: "шт" }],
};

const noMatcher: Matcher = { async searchTerms() { return []; }, async matchIngredient() { return null; } };
const llmResolve = (ids: number[]): Llm => ({ async structured() { return { matchedIds: ids, unmatched: [] } as never; } });
const llmDish = (d: Dish): Llm => ({ async structured() { return { dish: d } as never; } });

type Sent = { method: string; payload: Record<string, unknown> };

function harness(db: ReturnType<typeof openDb>, dishes: Dish[], llm: Llm, matcher: Matcher = noMatcher) {
  const sent: Sent[] = [];
  const bot = createBot({
    token: "TEST", allowedUserIds: [USER], dishes, matcher, llm, db,
    plz: 30459, menuDays: 7, householdSize: 2,
  });
  // Avoid the getMe network call.
  bot.botInfo = {
    id: 1, is_bot: true, first_name: "T", username: "t",
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  } as never;
  // Intercept all outgoing API calls — record, never hit the network.
  bot.api.config.use((async (_prev: unknown, method: string, payload: Record<string, unknown>) => {
    sent.push({ method, payload });
    const result = method === "sendMessage"
      ? { message_id: sent.length, date: 0, chat: { id: USER, type: "private" }, text: payload.text }
      : true;
    return { ok: true, result };
  }) as never);
  return { bot, sent };
}

function textUpdate(text: string, from = USER) {
  return {
    update_id: Math.floor(text.length + from),
    message: {
      message_id: 1, date: 0,
      chat: { id: from, type: "private" },
      from: { id: from, is_bot: false, first_name: "U" },
      text,
    },
  } as never;
}

const lastText = (sent: Sent[]): string =>
  String(sent.filter((s) => s.method === "sendMessage").at(-1)?.payload.text ?? "");

test("ignores messages from a non-whitelisted user", async () => {
  const db = openDb(":memory:");
  const { bot, sent } = harness(db, [], llmResolve([]));
  await bot.handleUpdate(textUpdate("добавь плов", 999));
  expect(sent).toHaveLength(0);
});

test("routes 'добавь X' to add_dishes and persists the selection", async () => {
  const db = openDb(":memory:");
  const id = insertDish(db, plov);
  const { bot, sent } = harness(db, [{ ...plov, id }], llmResolve([id]));
  await bot.handleUpdate(textUpdate("добавь плов"));
  expect(lastText(sent)).toContain("Плов");
  expect(getSelection(db, isoWeek(new Date()))).toContain(id);
});

test("routes '<dish> на N порций' to scale_dish", async () => {
  const db = openDb(":memory:");
  const id = insertDish(db, plov);
  const { bot, sent } = harness(db, [{ ...plov, id }], llmResolve([id]));
  await bot.handleUpdate(textUpdate("плов на 8 порций"));
  const out = lastText(sent);
  expect(out).toContain("рис");
  expect(out).toContain("2"); // 1кг @ 4 → 2кг @ 8
});

test("routes 'добавь блюдо X' to a preview with an inline keyboard (no persist yet)", async () => {
  const db = openDb(":memory:");
  const { bot, sent } = harness(db, [], llmDish(shakshuka));
  await bot.handleUpdate(textUpdate("добавь блюдо шакшука"));
  const msg = sent.find((s) => s.method === "sendMessage");
  expect(String(msg?.payload.text)).toContain("Шакшука");
  expect(msg?.payload.reply_markup).toBeDefined(); // confirm/cancel buttons
  expect(listDishes(db)).toHaveLength(0); // nothing saved until confirmed
});

import { test, expect } from "bun:test";
import { createBot } from "../src/bot/bot";
import { openDb } from "../src/db/db";
import { insertDish, listDishes } from "../src/recipes/recipeStore";
import { getSelection, saveSelection } from "../src/recipes/selectionStore";
import { isoWeek } from "../src/util/week";
import type { Dish } from "../src/types";
import type { Matcher } from "../src/matcher";
import type { Llm } from "../src/llm/llm";
import { getPantry } from "../src/recipes/pantryStore";

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
  const isCmd = text.startsWith("/");
  const cmdLength = isCmd ? (text.split(" ")[0]?.length ?? text.length) : 0;
  return {
    update_id: Math.floor(text.length + from),
    message: {
      message_id: 1, date: 0,
      chat: { id: from, type: "private" },
      from: { id: from, is_bot: false, first_name: "U" },
      text,
      ...(isCmd ? { entities: [{ type: "bot_command", offset: 0, length: cmdLength }] } : {}),
    },
  } as never;
}

const lastText = (sent: Sent[]): string =>
  String(sent.filter((s) => s.method === "sendMessage").at(-1)?.payload.text ?? "");

let cbId = 0;
function callbackUpdate(data: string, from = USER) {
  cbId += 1;
  return {
    update_id: 10000 + cbId,
    callback_query: {
      id: "cb" + cbId,
      from: { id: from, is_bot: false, first_name: "U" },
      chat_instance: "ci",
      message: { message_id: 1, date: 0, chat: { id: from, type: "private" }, from: { id: 1, is_bot: true, first_name: "T" }, text: "preview" },
      data,
    },
  } as never;
}

// resolve_dishes → {matchedIds, unmatched}; save_dish → {dish: byName(<name>)}
function llmResolveAndGen(matchedIds: number[], unmatched: string[], byName: (name: string) => Dish): Llm {
  return {
    async structured(args: { toolName?: string; prompt?: string }) {
      if (args.toolName === "save_dish") {
        const m = String(args.prompt).match(/the single dish "([^"]+)"/);
        return { dish: byName(m?.[1] ?? "") } as never;
      }
      return { matchedIds, unmatched } as never; // resolve_dishes
    },
  };
}

const dish = (nameRu: string): Dish => ({
  nameRu, nameUa: null, nameDe: null, cuisine: "ru", course: "second",
  keepsDays: 2, tags: [], servings: 4, ingredients: [{ canonical: "соль", qty: null, unit: null }],
});

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

test("'у меня есть рис' persists to the week's pantry", async () => {
  const db = openDb(":memory:");
  const { bot } = harness(db, [], llmResolve([]));
  await bot.handleUpdate(textUpdate("у меня есть рис"));
  expect(getPantry(db, isoWeek(new Date()))).toContain("рис");
});

test("pantry ingredients are hidden from /list", async () => {
  const db = openDb(":memory:");
  const dish: Dish = {
    nameRu: "Плов", nameUa: null, nameDe: null, cuisine: "ru", course: "second",
    keepsDays: 3, tags: [], servings: 4,
    ingredients: [{ canonical: "рис", qty: 1, unit: "кг" }, { canonical: "мясо", qty: 1, unit: "кг" }],
  };
  const id = insertDish(db, dish);
  saveSelection(db, isoWeek(new Date()), [id]);
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) {
      return { externalId: 1, store: "aldi", storeName: "Aldi", product: c, price: 1, oldPrice: null, referencePrice: null, unit: "kg", validFrom: "", validTo: "" };
    },
  };
  const { bot, sent } = harness(db, [{ ...dish, id }], llmResolve([id]), matcher);
  await bot.handleUpdate(textUpdate("у меня есть рис"));
  await bot.handleUpdate(textUpdate("/list", USER));
  const out = lastText(sent);
  expect(out).toContain("Уже дома");
  expect(out).toContain("мясо");
});

test("listing a dish not in the catalogue offers to generate it; ✅ adds it to week + catalogue", async () => {
  const db = openDb(":memory:");
  const { bot, sent } = harness(db, [], llmResolveAndGen([], ["солянка"], () => dish("Солянка")));
  await bot.handleUpdate(textUpdate("добавь солянка"));
  const preview = sent.find((s) => s.method === "sendMessage" && String(s.payload.text).includes("Солянка") && s.payload.reply_markup);
  expect(preview).toBeDefined();           // preview with ✅/❌
  expect(listDishes(db)).toHaveLength(0);  // nothing saved yet
  await bot.handleUpdate(callbackUpdate("gen_yes"));
  const id = listDishes(db).find((d) => d.nameRu === "Солянка")?.id ?? null;
  expect(id).not.toBeNull();
  expect(getSelection(db, isoWeek(new Date()))).toContain(id);
});

test("two unmatched dishes are offered one at a time; ✅ then ❌ summarized", async () => {
  const db = openDb(":memory:");
  const byName = (n: string) => dish(n === "солянка" ? "Солянка" : "Рагу");
  const { bot, sent } = harness(db, [], llmResolveAndGen([], ["солянка", "рагу"], byName));
  await bot.handleUpdate(textUpdate("добавь солянка, рагу"));
  expect(sent.some((s) => String(s.payload.text).includes("Солянка") && s.payload.reply_markup)).toBe(true);
  await bot.handleUpdate(callbackUpdate("gen_yes")); // save Солянка → offer Рагу
  expect(sent.some((s) => String(s.payload.text).includes("Рагу") && s.payload.reply_markup)).toBe(true);
  await bot.handleUpdate(callbackUpdate("gen_no"));  // skip Рагу → summary
  const out = lastText(sent);
  expect(out).toContain("Солянка"); // added
  expect(out).toContain("Рагу");    // skipped
  expect(listDishes(db).map((d) => d.nameRu)).toEqual(["Солянка"]);
});

test("/start shows the main menu hub with inline buttons", async () => {
  const db = openDb(":memory:");
  const { bot, sent } = harness(db, [], llmResolve([]));
  await bot.handleUpdate(textUpdate("/start"));
  const hub = sent.find((s) => s.method === "sendMessage" && s.payload.reply_markup);
  expect(hub).toBeDefined();
  const kb = JSON.stringify(hub!.payload.reply_markup);
  expect(kb).toContain("Меню недели");
  expect(kb).toContain("Кладовка");
});

test("generation failure for an unmatched dish is skipped, not crashed", async () => {
  const db = openDb(":memory:");
  const llm: Llm = {
    async structured(args: { toolName?: string }) {
      if (args.toolName === "save_dish") throw new Error("llm down");
      return { matchedIds: [], unmatched: ["боб"] } as never;
    },
  };
  const { bot, sent } = harness(db, [], llm);
  await bot.handleUpdate(textUpdate("добавь боб"));
  const out = lastText(sent);
  expect(out).toContain("Не получилось сгенерировать");
  expect(out).not.toContain("Упс"); // guard's crash message must not appear
});

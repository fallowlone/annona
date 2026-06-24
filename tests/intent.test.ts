import { test, expect } from "bun:test";
import { classifyIntent } from "../src/bot/intent";
import { createLlm, type Llm, type LlmClient } from "../src/llm/llm";

const stub = (out: unknown): Llm => ({ async structured() { return out as never; } });

/** Real Llm wired to a fake Anthropic client that echoes one tool_use input,
 *  so the actual IntentSchema validation in llm.ts runs against `input`. */
const llmReturning = (input: unknown): Llm => {
  const client: LlmClient = {
    messages: { create: async () => ({ content: [{ type: "tool_use", input }] }) },
  };
  return createLlm({ apiKey: "test", model: "test", client });
};

test("classifyIntent returns the LLM-classified intent", async () => {
  const llm = stub({ kind: "select_dishes", dishNames: ["борщ", "карбонара"] });
  const intent = await classifyIntent(llm, "хочу борщ и карбонару");
  expect(intent.kind).toBe("select_dishes");
  expect(intent.dishNames).toEqual(["борщ", "карбонара"]);
});

test("classifyIntent passes the user message into the prompt", async () => {
  let seenPrompt = "";
  const llm: Llm = {
    async structured(a) { seenPrompt = a.prompt; return { kind: "help", dishNames: [] } as never; },
  };
  await classifyIntent(llm, "что приготовить?");
  expect(seenPrompt).toContain("что приготовить?");
});

test("classifyIntent accepts scale_dish with targetServings", async () => {
  const llm = llmReturning({ kind: "scale_dish", dishNames: ["плов"], targetServings: 8 });
  const intent = await classifyIntent(llm, "свари плов человек на восемь");
  expect(intent.kind).toBe("scale_dish");
  expect(intent.targetServings).toBe(8);
});

test("classifyIntent accepts pantry/edit intents beyond the original five", async () => {
  const add = await classifyIntent(
    llmReturning({ kind: "add_pantry", dishNames: ["рис", "лук"] }),
    "дома есть рис и лук"
  );
  expect(add.kind).toBe("add_pantry");
  expect(add.dishNames).toEqual(["рис", "лук"]);

  const del = await classifyIntent(
    llmReturning({ kind: "delete_dish", dishNames: ["борщ"] }),
    "выкинь борщ из каталога"
  );
  expect(del.kind).toBe("delete_dish");
});

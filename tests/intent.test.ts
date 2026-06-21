import { test, expect } from "bun:test";
import { classifyIntent } from "../src/bot/intent";
import type { Llm } from "../src/llm/llm";

const stub = (out: unknown): Llm => ({ async structured() { return out as never; } });

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

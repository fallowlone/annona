import { test, expect } from "bun:test";
import { z } from "zod";
import { createLlm, type LlmClient } from "../src/llm/llm";

function clientReturning(inputs: unknown[]): LlmClient {
  let i = 0;
  return {
    messages: {
      create: async () => ({ content: [{ type: "tool_use", name: "t", input: inputs[Math.min(i++, inputs.length - 1)] }] }),
    },
  };
}

test("structured returns validated tool input", async () => {
  const llm = createLlm({ apiKey: "x", model: "claude-haiku-4-5", client: clientReturning([{ terms: ["Schmand"] }]) });
  const out = await llm.structured({
    prompt: "translate сметана", toolName: "t", description: "d",
    schema: z.object({ terms: z.array(z.string()) }),
  });
  expect(out.terms).toEqual(["Schmand"]);
});

test("structured retries once on invalid output then succeeds", async () => {
  const llm = createLlm({
    apiKey: "x", model: "claude-haiku-4-5",
    client: clientReturning([{ wrong: true }, { terms: ["Dill"] }]),
  });
  const out = await llm.structured({
    prompt: "x", toolName: "t", description: "d",
    schema: z.object({ terms: z.array(z.string()) }),
  });
  expect(out.terms).toEqual(["Dill"]);
});

test("structured throws after two invalid outputs", async () => {
  const llm = createLlm({
    apiKey: "x", model: "claude-haiku-4-5",
    client: clientReturning([{ wrong: true }]),
  });
  await expect(
    llm.structured({ prompt: "x", toolName: "t", description: "d", schema: z.object({ terms: z.array(z.string()) }) })
  ).rejects.toThrow();
});

test("structured retries when no tool_use block is present", async () => {
  let call = 0;
  const client: LlmClient = {
    messages: {
      create: async () => {
        call++;
        if (call === 1) return { content: [{ type: "text", text: "oops" }] };
        return { content: [{ type: "tool_use", name: "t", input: { terms: ["Butter"] } }] };
      },
    },
  };
  const llm = createLlm({ apiKey: "x", model: "claude-haiku-4-5", client });
  const out = await llm.structured({
    prompt: "x", toolName: "t", description: "d",
    schema: z.object({ terms: z.array(z.string()) }),
  });
  expect(out.terms).toEqual(["Butter"]);
  expect(call).toBe(2);
});

test("client is called with the configured model id", async () => {
  const calls: unknown[] = [];
  const client: LlmClient = {
    messages: {
      create: async (req) => {
        calls.push(req);
        return { content: [{ type: "tool_use", name: "t", input: { terms: ["ok"] } }] };
      },
    },
  };
  const llm = createLlm({ apiKey: "x", model: "claude-haiku-4-5", client });
  await llm.structured({ prompt: "x", toolName: "t", description: "d", schema: z.object({ terms: z.array(z.string()) }) });
  expect((calls[0] as { model: string }).model).toBe("claude-haiku-4-5");
});

test("client is called with tool_choice forced to the tool name", async () => {
  const calls: unknown[] = [];
  const client: LlmClient = {
    messages: {
      create: async (req) => {
        calls.push(req);
        return { content: [{ type: "tool_use", name: "t", input: { terms: ["ok"] } }] };
      },
    },
  };
  const llm = createLlm({ apiKey: "x", model: "claude-haiku-4-5", client });
  await llm.structured({ prompt: "x", toolName: "myTool", description: "d", schema: z.object({ terms: z.array(z.string()) }) });
  const req = calls[0] as { tool_choice: { type: string; name: string } };
  expect(req.tool_choice).toEqual({ type: "tool", name: "myTool" });
});

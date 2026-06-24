import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { log } from "../log";

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export interface Llm {
  structured<T>(args: {
    system?: string;
    prompt: string;
    toolName: string;
    description: string;
    schema: z.ZodType<T>;
    maxTokens?: number;
  }): Promise<T>;
}

export type LlmClient = {
  messages: { create: (req: unknown) => Promise<{ content: unknown[] }> };
};

export function createLlm(deps: { apiKey: string; model: string; client?: LlmClient }): Llm {
  const client: LlmClient =
    deps.client ?? (new Anthropic({ apiKey: deps.apiKey }) as unknown as LlmClient);

  async function once<T>(a: {
    system?: string;
    prompt: string;
    toolName: string;
    description: string;
    schema: z.ZodType<T>;
    maxTokens?: number;
  }): Promise<T> {
    // zod v4 ships native JSON Schema conversion. (The old zod-to-json-schema lib
    // targets zod v3 and silently emits a schema with no root "type" against a v4
    // schema, which the Anthropic API rejects with "input_schema.type: Field required".)
    const inputSchema = z.toJSONSchema(a.schema);
    const res = await client.messages.create({
      model: deps.model,
      max_tokens: a.maxTokens ?? 1024,
      ...(a.system !== undefined ? { system: a.system } : {}),
      tools: [{ name: a.toolName, description: a.description, input_schema: inputSchema }],
      tool_choice: { type: "tool", name: a.toolName },
      messages: [{ role: "user", content: a.prompt }],
    });
    // Emit token usage so spend is measurable (and a cache breakpoint, once
    // added, is verifiable via cacheRead > 0). Costs nothing if usage is absent.
    const u = (res as { usage?: Usage }).usage;
    if (u) {
      log.info("llm_usage", {
        tool: a.toolName,
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
      });
    }
    const block = (res.content as Array<{ type: string; input?: unknown }>).find(
      (b) => b.type === "tool_use"
    );
    if (!block) throw new Error("llm: no tool_use block in response");
    return a.schema.parse(block.input);
  }

  // Worth a second identical attempt only when the model produced a malformed
  // shape (schema violation or no tool_use block). A transport/API error was
  // already retried by the SDK, so re-calling just doubles the spend.
  const isModelShapeError = (e: unknown): boolean =>
    e instanceof z.ZodError ||
    (e instanceof Error && e.message.includes("no tool_use"));

  return {
    async structured(a) {
      try {
        return await once(a);
      } catch (first) {
        if (!isModelShapeError(first)) throw first;
        try {
          return await once(a);
        } catch (second) {
          throw new Error(`llm.structured failed after one retry: ${String(second)}`, { cause: first });
        }
      }
    },
  };
}

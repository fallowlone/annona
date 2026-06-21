import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface Llm {
  structured<T>(args: {
    system?: string;
    prompt: string;
    toolName: string;
    description: string;
    schema: z.ZodType<T>;
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
  }): Promise<T> {
    const inputSchema = zodToJsonSchema(a.schema, { target: "jsonSchema7" });
    const res = await client.messages.create({
      model: deps.model,
      max_tokens: 1024,
      ...(a.system !== undefined ? { system: a.system } : {}),
      tools: [{ name: a.toolName, description: a.description, input_schema: inputSchema }],
      tool_choice: { type: "tool", name: a.toolName },
      messages: [{ role: "user", content: a.prompt }],
    });
    const block = (res.content as Array<{ type: string; input?: unknown }>).find(
      (b) => b.type === "tool_use"
    );
    if (!block) throw new Error("llm: no tool_use block in response");
    return a.schema.parse(block.input);
  }

  return {
    async structured(a) {
      try {
        return await once(a);
      } catch {
        return await once(a); // one retry on validation failure or missing tool_use
      }
    },
  };
}

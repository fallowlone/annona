import { z } from "zod";

const csvNumbers = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map(Number)
  )
  .pipe(z.array(z.number().int()).min(1));

const schema = z.object({
  LOCATION_PLZ: z.coerce.number().int().default(30459),
  LOCATION_CITY: z.string().default("Hannover"),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_USER_IDS: csvNumbers,
  ANTHROPIC_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().default("claude-haiku-4-5"),
  PROXY_MODE: z.enum(["none", "pool", "service"]).default("none"),
});

export type ProxyMode = "none" | "pool" | "service";

export type Config = {
  locationPlz: number;
  locationCity: string;
  telegramBotToken: string;
  allowedUserIds: number[];
  anthropicApiKey: string;
  llmModel: string;
  proxyMode: ProxyMode;
};

export function loadConfig(env: Record<string, string | undefined>): Config {
  const p = schema.parse(env);
  return {
    locationPlz: p.LOCATION_PLZ,
    locationCity: p.LOCATION_CITY,
    telegramBotToken: p.TELEGRAM_BOT_TOKEN,
    allowedUserIds: p.ALLOWED_USER_IDS,
    anthropicApiKey: p.ANTHROPIC_API_KEY,
    llmModel: p.LLM_MODEL,
    proxyMode: p.PROXY_MODE,
  };
}

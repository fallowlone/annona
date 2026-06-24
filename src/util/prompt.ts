/**
 * Neutralize untrusted text before interpolating it into an LLM prompt: collapse
 * control characters / newlines, normalize quote and backtick delimiters, and cap
 * length. This is hardening, not the primary control — forced `tool_choice` plus
 * the zod schema remain the real backstop against prompt-injection escaping the
 * typed output shape.
 */
export function sanitizePromptText(s: string, maxLen = 200): string {
  return s
    .replace(/\p{Cc}+/gu, " ")
    .replace(/[`"«»]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

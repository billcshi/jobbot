/**
 * Parse JSON from LLM responses, handling common formatting quirks:
 * - Markdown code fences (```json ... ``` or ``` ... ```)
 * - Leading/trailing whitespace
 * - JSON block embedded within surrounding text
 *
 * On failure, dumps the raw content to console.error for debugging
 * before throwing.
 *
 * @param content  The raw text content from the LLM response.
 * @param label    Optional context label for error messages (e.g., "extract job #42").
 */
export function parseLLMJson(content: string, label?: string): unknown {
  const prefix = label ? `[${label}] ` : '';
  let text = content.trim();

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    text = fenceMatch[1]!.trim();
  }

  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    // Try to extract the first JSON object or array from within text
    const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // fall through to error
      }
    }
    // Dump raw content for debugging
    console.error(`${prefix}LLM JSON parse failed. Raw response:\n--- BEGIN RAW ---\n${content.slice(0, 2000)}\n--- END RAW ---`);
    throw new Error(
      `${prefix}Failed to parse LLM JSON response: ${text.slice(0, 500)}`,
    );
  }
}

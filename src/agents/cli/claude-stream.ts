// Чистый парсер/классификатор строк stream-json вывода Claude CLI.
// Никаких побочек — только разбор JSON и классификация события.
// Побочные эффекты (stderr, аудит, лог-файл, таймеры) остаются в runner.ts.

export type ClaudeStreamEvent =
  | { kind: "tool_use"; toolName: string; toolInput: unknown; toolUseId: string }
  | { kind: "tool_result"; toolName: string; toolUseId: string }
  | { kind: "result"; result: string }
  | { kind: "error"; message: string }
  | { kind: "other" };

interface ClaudeContentBlock {
  type?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
}

// Граница с внешним нетипизированным JSON от CLI.
// guardian: allow — динамическая форма события Claude stream-json.
export function classifyClaudeEvent(ev: any): ClaudeStreamEvent { // guardian: allow
  const isToolUse =
    ev.type === "tool_use" ||
    (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") ||
    (ev.type === "assistant" && ev.message?.content?.some((c: ClaudeContentBlock) => c.type === "tool_use"));
  if (isToolUse) {
    let toolName = ev.name || ev.content_block?.name || "unknown";
    let toolInput = ev.input || ev.content_block?.input || {};
    let toolUseId = ev.id || ev.content_block?.id || "unknown";
    if (ev.type === "assistant" && ev.message?.content) {
      const tu = ev.message.content.find((c: ClaudeContentBlock) => c.type === "tool_use");
      if (tu) {
        toolName = tu.name || "unknown";
        toolInput = tu.input || {};
        toolUseId = tu.id || "unknown";
      }
    }
    return { kind: "tool_use", toolName, toolInput, toolUseId };
  }

  const isToolResult =
    ev.type === "tool_result" ||
    ev.type === "content_block_stop" ||
    (ev.type === "user" && ev.message?.content?.some((c: ClaudeContentBlock) => c.type === "tool_result"));
  if (isToolResult) {
    let toolName = ev.tool_name || "";
    let toolUseId = ev.tool_use_id || "";
    if (ev.type === "user" && ev.message?.content) {
      const tr = ev.message.content.find((c: ClaudeContentBlock) => c.type === "tool_result");
      if (tr) {
        toolName = tr.tool_use_id || "";
        toolUseId = tr.tool_use_id || "";
      }
    }
    return { kind: "tool_result", toolName, toolUseId };
  }

  if (ev.type === "result") {
    return { kind: "result", result: ev.result ?? "" };
  }

  if (ev.type === "error") {
    return { kind: "error", message: ev.message };
  }

  return { kind: "other" };
}

/**
 * Разбирает одну строку stream-json. Повторяет исходную «обрезку до
 * последней }» (CLI иногда дописывает мусор после JSON-объекта).
 * Возвращает null для пустых строк и нераспарсиваемого JSON.
 */
export function parseClaudeStreamLine(line: string): ClaudeStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let jsonStr = trimmed;
  const lastBrace = jsonStr.lastIndexOf("}");
  if (lastBrace !== -1) {
    jsonStr = jsonStr.substring(0, lastBrace + 1);
  }
  try {
    return classifyClaudeEvent(JSON.parse(jsonStr));
  } catch {
    return null;
  }
}

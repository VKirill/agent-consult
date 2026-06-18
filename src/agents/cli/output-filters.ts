// Чистые детекторы по тексту вывода CLI (без побочек). Используются в
// runner.ts для управления idle-таймером и обрыва неавторизованных сессий.

/**
 * Распознаёт приглашение к интерактивному входу (CLI не авторизован).
 * Анти-false-positive: не срабатывает, когда в выводе виден исходный код,
 * упоминающий эти же слова (агент мог напечатать кусок кода).
 */
export function detectsInteractiveAuth(text: string): boolean {
  if (
    text.includes("includes") ||
    text.includes("outputToCheck") ||
    text.includes("const ") ||
    text.includes("function")
  ) {
    return false;
  }

  const hasClaudeAuth = /To sign in, open this URL:\s*https?:\/\//i.test(text);
  const hasCodexAuth = /Confirm this code|Waiting for authorization/i.test(text);
  const hasGrokAuth = /oauth2\/device/i.test(text) && /https?:\/\//i.test(text);

  return hasClaudeAuth || hasCodexAuth || hasGrokAuth;
}

/**
 * Эвристика активности MCP-инструмента по тексту вывода — управляет
 * выбором idle-таймаута (вызов инструмента может идти дольше генерации).
 */
export function detectToolActivity(text: string | undefined): { isToolCall: boolean; isToolResult: boolean } {
  if (!text) return { isToolCall: false, isToolResult: false };
  const lower = text.toLowerCase();
  const isToolCall =
    lower.includes("calling tool") ||
    lower.includes("using tool") ||
    lower.includes("tool_use") ||
    lower.includes("callmcptool") ||
    lower.includes("running tool") ||
    lower.includes("вызов инструмента") ||
    lower.includes("запуск инструмента");
  const isToolResult =
    lower.includes("tool_result") ||
    lower.includes("вернул результат") ||
    lower.includes("tool completed") ||
    lower.includes("tool output");
  return { isToolCall, isToolResult };
}

/** Вытаскивает имя инструмента из свободного текста (для не-claude агентов). */
export function parseToolNameFromText(text: string | undefined): string {
  const match = text ? text.match(/(?:calling|using|running|tool|инструмента)\s+([a-zA-Z0-9_\-/]+)/i) : null;
  return match ? match[1] : "unknown_mcp_tool";
}

const SPINNER_RE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\-|\/\\]+$/;

/** Шумовые stderr-строки (предупреждения Node и анимации спиннера), которые пропускаем. */
export function isIgnorableStderrLine(cleanLine: string): boolean {
  if (cleanLine.includes("ExperimentalWarning:") || cleanLine.includes("DeprecationWarning:")) {
    return true;
  }
  return SPINNER_RE.test(cleanLine);
}

/** Похожа ли stderr-строка на ошибку (для проброса в лог оркестратора). */
export function isErrorLikeStderrLine(cleanLine: string): boolean {
  const lower = cleanLine.toLowerCase();
  return (
    lower.includes("error") ||
    lower.includes("fail") ||
    lower.includes("except") ||
    lower.includes("fatal") ||
    lower.includes("warn")
  );
}

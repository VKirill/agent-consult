export function sanitizeLogMessage(message: string): string {
  if (typeof message !== "string") return message;
  
  return message
    .replace(/(sk-or-v1-[a-zA-Z0-9]{64})/g, "[REDACTED_OPENROUTER_KEY]")
    .replace(/(sk-[a-zA-Z0-9]{20,})/g, "[REDACTED_API_KEY]")
    .replace(/(Authorization:\s*Bearer\s+)[a-zA-Z0-9_\-\.]+/ig, "$1[REDACTED_TOKEN]")
    .replace(/"(password|token|apiKey|secret)":\s*"(?!\[REDACTED)[^"]+"/ig, '"$1": "[REDACTED]"');
}

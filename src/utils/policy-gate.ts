import { loadConfig } from "../core/config.js";
import { sanitizeLogMessage } from "./security.js";

export interface PolicyValidationResult {
  allowed: boolean;
  reason?: string;
  sanitizedArguments: any;
}

/**
 * Проверяет разрешения и маскирует конфиденциальные данные перед вызовом инструмента.
 */
export async function validateToolCallPolicy(
  role: string,
  toolName: string,
  args: any
): Promise<PolicyValidationResult> {
  // 1. Извлекаем имя сервера из формата "mcp_serverName_toolName" или "serverName/toolName"
  let serverName = "unknown";
  
  if (toolName.includes("/")) {
    serverName = toolName.split("/")[0];
  } else if (toolName.startsWith("mcp_")) {
    // Формат eager-загрузки: mcp_serverName_toolName
    const parts = toolName.split("_");
    if (parts.length > 1) {
      serverName = parts[1];
    }
  }

  // 2. Загружаем конфигурацию
  const config = await loadConfig();
  const mapping = config.role_mcp_mapping || {};
  const allowedServers = mapping[role] || mapping["general"] || [];

  // Проверяем, разрешен ли этот МЦП-сервер для текущей роли
  // Игнорируем проверку для стандартных/системных инструментов (не имеющих приставки mcp_ или /)
  const isMcpTool = toolName.includes("/") || toolName.startsWith("mcp_");
  
  if (isMcpTool && serverName !== "unknown") {
    const isAllowed = allowedServers.includes(serverName);
    if (!isAllowed) {
      return {
        allowed: false,
        reason: `МЦП-сервер '${serverName}' не разрешен для роли '${role}'. Доступные серверы: [${allowedServers.join(", ")}]`,
        sanitizedArguments: args
      };
    }
  }

  // 3. Санитизация аргументов (маскирование паролей, токенов, ключей)
  let sanitizedArguments = args;
  try {
    if (args && typeof args === "object") {
      const serialized = JSON.stringify(args);
      const sanitizedStr = sanitizeLogMessage(serialized);
      sanitizedArguments = JSON.parse(sanitizedStr);
    }
  } catch (err) {
    // В случае ошибки парсинга оставляем оригинальные аргументы, но предупреждаем
  }

  return {
    allowed: true,
    sanitizedArguments
  };
}

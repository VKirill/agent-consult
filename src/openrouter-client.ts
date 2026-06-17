import { AgentConfig } from "./config.js";

export interface AgentResponse {
  agentName: string;
  model: string;
  success: boolean;
  content?: string;
  error?: string;
  durationMs: number;
  personality?: string;
}

/**
 * Маппит короткие или устаревшие имена моделей на официальные идентификаторы OpenRouter.
 */
export function resolveOpenRouterModel(modelName: string): string {
  const mapping: Record<string, string> = {
    "sonnet": "anthropic/claude-sonnet-4",
    "opus": "anthropic/claude-opus-4",
    "haiku": "anthropic/claude-3-haiku",
    "xai/grok-composer-2.5-fast": "x-ai/grok-4.20",
    "openai/gpt-5.5": "openai/gpt-5.5",
    "xiaomi/mimo-v2.5-pro": "meta-llama/llama-3.3-70b-instruct",
  };

  if (mapping[modelName]) {
    return mapping[modelName];
  }

  // Если имя без слэша, пробуем добавить вендора
  if (!modelName.includes("/")) {
    if (modelName.startsWith("gpt-")) return `openai/${modelName}`;
    if (modelName.startsWith("claude-")) return `anthropic/${modelName}`;
    if (modelName.startsWith("gemini-")) return `google/${modelName}`;
    if (modelName.startsWith("grok-")) return `xai/${modelName}`;
  }

  return modelName;
}

/**
 * Выполняет запрос к OpenRouter API с поддержкой таймаута и повторных попыток
 */
export async function queryOpenRouter(
  apiKey: string,
  modelName: string,
  systemPrompt: string,
  userPrompt: string,
  agentConfig: AgentConfig,
  timeoutMs: number,
  retryAttempts: number,
  referer?: string,
  title?: string
): Promise<string> {
  if (!apiKey || apiKey === "YOUR_OPENROUTER_API_KEY_HERE") {
    throw new Error("API ключ OpenRouter не задан. Пожалуйста, укажите OPENROUTER_API_KEY в окружении или файле config.json.");
  }

  const resolvedModel = resolveOpenRouterModel(modelName);
  const url = "https://openrouter.ai/api/v1/chat/completions";
  
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": referer || "https://github.com/modelcontextprotocol/agent-consult",
    "X-Title": title || "Agent Consult MCP Server"
  };

  const body: any = {
    model: resolvedModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  };

  // Настройка reasoning
  if (agentConfig.reasoning?.enable) {
    // OpenAI o1/o3-mini используют reasoning_effort
    if (resolvedModel.includes("o1") || resolvedModel.includes("o3")) {
      body.reasoning_effort = agentConfig.reasoning.reasoning_effort || "medium";
    }
  }

  let lastError: any;
  
  for (let attempt = 1; attempt <= retryAttempts + 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        let errorText = await response.text().catch(() => "");
        if (errorText.length > 256) errorText = errorText.slice(0, 256) + "...(truncated)";
        if (/<!DOCTYPE html>|<html>/i.test(errorText)) errorText = "[HTML error page]";
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${errorText}`);
      }

      const data = await response.json();

      const choice = data.choices?.[0];
      if (!choice || !choice.message?.content) {
        throw new Error("Неверный формат ответа от OpenRouter API: отсутствует choices[0].message.content");
      }

      return choice.message.content.trim();
    } catch (err: any) {
      lastError = err;
      
      const isAbort = err.name === "AbortError";
      const errorMsg = isAbort ? `таймаут ожидания (${timeoutMs}мс)` : err.message;
      
      process.stderr.write(`[OpenRouter Client] Ошибка при запросе модели ${resolvedModel} (Попытка ${attempt}/${retryAttempts + 1}): ${errorMsg}\n`);
      
      if (attempt <= retryAttempts) {
        // Задержка перед следующей попыткой (exponential backoff)
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

/**
 * Проверяет жизнеспособность (liveness) подключения к OpenRouter
 */
export async function checkOpenRouterLiveness(apiKey: string): Promise<boolean> {
  if (!apiKey || apiKey === "YOUR_OPENROUTER_API_KEY_HERE") {
    return false;
  }

  try {
    const url = "https://openrouter.ai/api/v1/models";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000); // Короткий таймаут 10с

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        signal: controller.signal
      });

      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    process.stderr.write(`[Liveness Check] Ошибка при проверке связи с OpenRouter: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}

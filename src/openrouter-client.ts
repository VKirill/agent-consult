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
/**
 * Класс типизированной ошибки OpenRouter API
 */
export class OpenRouterError extends Error {
  public readonly status?: number;
  public readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number; retryable: boolean; cause?: unknown }
  ) {
    super(message);
    this.name = "OpenRouterError";
    this.status = options.status;
    this.retryable = options.retryable;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    
    // Восстанавливаем прототип для корректной работы instanceof в ES5+
    Object.setPrototypeOf(this, OpenRouterError.prototype);
  }
}

/**
 * Определяет, является ли HTTP-статус повторяемым
 */
export function isHttpErrorRetryable(status: number): boolean {
  // 429 (Rate Limit) и все 5xx ошибки являются временными сбоями
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

/**
 * Извлекает задержку из заголовка Retry-After (секунды или HTTP-date)
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * Вычисляет задержку с Exponential Backoff + Full Jitter.
 * Уважает Retry-After при 429; увеличивает cap для Rate Limit.
 */
export function calculateFullJitterDelay(
  attempt: number,
  baseMs = 1000,
  capMs = 10000,
  retryAfterMs?: number | null
): number {
  // Если сервер вернул Retry-After — берём его как нижнюю границу + jitter
  if (retryAfterMs != null && retryAfterMs > 0) {
    const jitter = Math.floor(Math.random() * 1000);
    return retryAfterMs + jitter;
  }

  const temp = Math.min(capMs, baseMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * temp);
}

/**
 * Вспомогательный метод для выполнения запроса к конкретной модели
 * с индивидуальным циклом ретраев и Full Jitter задержками.
 */
async function querySingleModelWithRetries(
  apiKey: string,
  resolvedModel: string,
  systemPrompt: string,
  userPrompt: string,
  agentConfig: AgentConfig,
  timeoutMs: number,
  retryAttempts: number,
  referer?: string,
  title?: string
): Promise<string> {
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

  if (agentConfig.reasoning?.enable) {
    if (resolvedModel.includes("o1") || resolvedModel.includes("o3")) {
      body.reasoning_effort = agentConfig.reasoning.reasoning_effort || "medium";
    }
  }

  let lastError: any;
  let retryAfterMs: number | null = null;

  for (let attempt = 1; attempt <= retryAttempts + 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

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

        const status = response.status;
        retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));

        throw new OpenRouterError(
          `HTTP ${status} ${response.statusText}: ${errorText}`,
          { status, retryable: isHttpErrorRetryable(status) }
        );
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      if (!choice || !choice.message?.content) {
        throw new OpenRouterError(
          "Неверный формат ответа от OpenRouter API: отсутствует choices[0].message.content",
          { retryable: false }
        );
      }

      return choice.message.content.trim();
    } catch (err: any) {
      let openRouterError: OpenRouterError;

      if (err instanceof OpenRouterError) {
        openRouterError = err;
      } else {
        const isAbort = err.name === "AbortError";
        const errorMsg = isAbort ? `таймаут ожидания (${timeoutMs}мс)` : err.message;
        openRouterError = new OpenRouterError(errorMsg, { retryable: true, cause: err });
      }

      lastError = openRouterError;
      process.stderr.write(`[OpenRouter Client] ${resolvedModel} (попытка ${attempt}/${retryAttempts + 1}): ${openRouterError.message}\n`);

      if (!openRouterError.retryable) break;

      if (attempt <= retryAttempts) {
        // 429: cap 30с вместо 10с
        const cap = openRouterError.status === 429 ? 30_000 : 10_000;
        const delay = calculateFullJitterDelay(attempt, 1000, cap, retryAfterMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

/**
 * Дефолтные fallback-цепочки по семействам моделей.
 * Ключ — подстрока основной модели; значение — резервные модели по убчанию.
 */
/**
 * Возвращает только основную модель — fallback-цепочки отключены
 * (используем строго CLI-подписки / заданную модель, без облачных подмен).
 */
function buildModelChain(modelName: string): string[] {
  return [modelName];
}

/**
 * Выполняет запрос к OpenRouter API с поддержкой таймаута, повторных попыток с Full Jitter и Fallback моделей
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

  const modelsChain = buildModelChain(modelName);

  let lastError: any;

  for (let modelIdx = 0; modelIdx < modelsChain.length; modelIdx++) {
    const currentModel = modelsChain[modelIdx];
    const resolvedModel = resolveOpenRouterModel(currentModel);

    try {
      if (modelIdx > 0) {
        process.stderr.write(`[OpenRouter Client] Переключение на резервную модель: ${resolvedModel} (основная завершилась сбоем)\n`);
      }
      return await querySingleModelWithRetries(
        apiKey,
        resolvedModel,
        systemPrompt,
        userPrompt,
        agentConfig,
        timeoutMs,
        retryAttempts,
        referer,
        title
      );
    } catch (err: any) {
      lastError = err;
      process.stderr.write(`[OpenRouter Client] Модель ${resolvedModel} завершилась неудачно: ${err.message}\n`);

      // Если это критическая ошибка авторизации (401 или 403), прекращаем обход цепочки (fail-fast)
      if (err instanceof OpenRouterError && (err.status === 401 || err.status === 403)) {
        throw err;
      }
    }
  }

  throw lastError || new Error("Все модели в цепочке fallback завершились сбоем.");
}

export type LivenessReason = "ok" | "missing_key" | "unauthorized" | "network";

export interface LivenessResult {
  ok: boolean;
  reason: LivenessReason;
}

/**
 * Проверяет реальную авторизацию в OpenRouter.
 * Бьёт в /api/v1/auth/key (требует валидный ключ), а НЕ в публичный /models —
 * иначе проверка проходила бы с любым мусорным ключом (ложный «✅ Доступен»).
 */
export async function checkOpenRouterLiveness(apiKey: string): Promise<LivenessResult> {
  if (!apiKey || apiKey.includes("YOUR_")) {
    return { ok: false, reason: "missing_key" };
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`
      },
      signal: AbortSignal.timeout(10_000)
    });
    if (response.ok) return { ok: true, reason: "ok" };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "unauthorized" };
    }
    return { ok: false, reason: "network" };
  } catch (err) {
    process.stderr.write(`[Liveness Check] Ошибка: ${err instanceof Error ? err.message : String(err)}\n`);
    return { ok: false, reason: "network" };
  }
}

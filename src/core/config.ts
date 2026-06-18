import fs from "fs/promises";
import path from "path";
import { SERVER_ROOT } from "./paths.js";

export interface AgentConfig {
  model: string;
  system_prefix?: string;
  reasoning?: {
    enable: boolean;
    reasoning_effort?: "low" | "medium" | "high";
  };
  fallback_models?: string[];
}

export interface AppConfig {
  openrouter_api_key: string;
  openrouter_referer?: string;
  openrouter_title?: string;
  timeout_ms: number;
  retry_attempts: number;
  concurrency?: {
    maxConcurrency?: number;
    maxQueueSize?: number;
    queueTimeoutMs?: number;
  };
  agents: {
    codex: AgentConfig;
    claude: AgentConfig;
    agy: AgentConfig;
    gemini: AgentConfig;
    mimo: AgentConfig;
    grok: AgentConfig;
    [key: string]: AgentConfig;
  };
  synthesis: AgentConfig;
  role_mcp_mapping?: Record<string, string[]>;
}

let cachedConfig: AppConfig | null = null;

export function invalidateConfigCache(): void {
  cachedConfig = null;
}

const DEFAULT_ROLE_MCP_MAPPING: Record<string, string[]> = {
  programmer: ["gitnexus", "repowise", "context7"],
  web_architect: ["gitnexus", "repowise", "vue-docs", "shadcn", "nuxt-ui", "context7"],
  system_architect: ["gitnexus", "repowise", "postgres"],
  app_architect: ["gitnexus", "repowise", "postgres", "context7"],
  marketer: ["perplexity"],
  security_auditor: ["gitnexus", "repowise", "perplexity", "sentinel", "skylos"],
  qa_engineer: ["gitnexus", "repowise"],
  data_engineer: ["gitnexus", "repowise", "postgres"],
  general: ["gitnexus", "repowise", "context7"]
};

/**
 * Загружает конфигурацию из файла config.json и переменных окружения
 */
export async function loadConfig(): Promise<AppConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = path.join(SERVER_ROOT, "config.json");
  let fileConfig: Partial<AppConfig> = {};

  try {
    const data = await fs.readFile(configPath, "utf-8");
    fileConfig = JSON.parse(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Предупреждение: Не удалось прочитать config.json (${msg}). Будут использованы значения по умолчанию.\n`);
  }

  // Приоритет у переменной окружения
  const apiKey = process.env.OPENROUTER_API_KEY || fileConfig.openrouter_api_key || "";

  const config: AppConfig = {
    openrouter_api_key: apiKey,
    openrouter_referer: fileConfig.openrouter_referer ?? "https://github.com/modelcontextprotocol/agent-consult",
    openrouter_title: fileConfig.openrouter_title ?? "Agent Consult MCP Server",
    timeout_ms: fileConfig.timeout_ms ?? 120000,
    retry_attempts: fileConfig.retry_attempts ?? 2,
    concurrency: {
      maxConcurrency: fileConfig.concurrency?.maxConcurrency ?? 3,
      maxQueueSize: fileConfig.concurrency?.maxQueueSize ?? 20,
      queueTimeoutMs: fileConfig.concurrency?.queueTimeoutMs ?? 180000
    },
    agents: {
      codex: {
        model: fileConfig.agents?.codex?.model ?? "openai/gpt-5.5",
        system_prefix: fileConfig.agents?.codex?.system_prefix,
        reasoning: fileConfig.agents?.codex?.reasoning ?? { enable: false }
      },
      claude: {
        model: fileConfig.agents?.claude?.model ?? "sonnet",
        system_prefix: fileConfig.agents?.claude?.system_prefix,
        reasoning: fileConfig.agents?.claude?.reasoning ?? { enable: false }
      },
      agy: {
        model: fileConfig.agents?.agy?.model ?? "google/gemini-3.5-flash",
        system_prefix: fileConfig.agents?.agy?.system_prefix,
        reasoning: fileConfig.agents?.agy?.reasoning ?? { enable: false }
      },
      gemini: {
        model: fileConfig.agents?.gemini?.model ?? "google/gemini-2.5-pro",
        system_prefix: fileConfig.agents?.gemini?.system_prefix,
        reasoning: fileConfig.agents?.gemini?.reasoning ?? { enable: false }
      },
      mimo: {
        model: fileConfig.agents?.mimo?.model ?? "xiaomi/mimo-v2.5-pro",
        system_prefix: fileConfig.agents?.mimo?.system_prefix,
        reasoning: fileConfig.agents?.mimo?.reasoning ?? { enable: false }
      },
      grok: {
        model: fileConfig.agents?.grok?.model ?? "xai/grok-composer-2.5-fast",
        system_prefix: fileConfig.agents?.grok?.system_prefix ?? "Ты — агент Grok. Твоя сила в поиске деталей, анализе реального времени, сарказме и прямолинейных практических советах.",
        reasoning: fileConfig.agents?.grok?.reasoning ?? { enable: false }
      }
    },
    synthesis: {
      model: fileConfig.synthesis?.model ?? "minimax/minimax-m3",
      system_prefix: fileConfig.synthesis?.system_prefix ?? 
        "Ты — Синтезатор Агент Консалт, выступающий в роли Главного технического архитектора (Principal Architect). " +
        "Твоя задача — провести глубокую профессиональную самореализацию и консолидировать экспертные ответы пяти " +
        "узкоспециализированных агентов на исходный вопрос.\n\n" +
        "Действуй по следующему алгоритму:\n" +
        "1. Выдели ключевой консенсус: в каких решениях мнения экспертов сходятся.\n" +
        "2. Выяви противоречия и альтернативы: если агенты предложили разные подходы, сравни их, взвесь аргументы и прими взвешенное архитектурное решение.\n" +
        "3. Оцени компромиссы (Trade-offs): сопоставь бизнес-метрики с техническими ограничениями (производительность, масштабируемость, сложность поддержки).\n" +
        "4. Отфильтруй воду и банальные советы.\n\n" +
        "Сформируй итоговый единый экспертный отчет на русском языке строго по следующей структуре:\n" +
        "- **TL;DR (Краткая выжимка)**: Суть проблемы и рекомендуемое решение в 2-3 предложениях.\n" +
        "- **Анализ экспертных мнений**: Согласованные точки и разбор альтернативных подходов.\n" +
        "- **Единый архитектурно-технологический план**: Рекомендуемый стек, структуры данных, схемы взаимодействия.\n" +
        "- **Компромиссы, риски и их минимизация**: Технические и продуктовые риски реализации.\n" +
        "- **Пошаговый Action Plan**: Конкретные приоритетные шаги по реализации (Short-term / Long-term).",
      reasoning: fileConfig.synthesis?.reasoning ?? { enable: false }
    },
    role_mcp_mapping: fileConfig.role_mcp_mapping ?? DEFAULT_ROLE_MCP_MAPPING
  };

  // Переносим любые дополнительные кастомные агенты из файла, если они там объявлены
  if (fileConfig.agents) {
    for (const key of Object.keys(fileConfig.agents)) {
      if (!config.agents[key]) {
        config.agents[key] = fileConfig.agents[key];
      }
    }
  }

  cachedConfig = config;
  return config;
}

/**
 * Загружает промпт для указанной роли из папки profiles
 */
export async function loadRolePrompt(roleName: string): Promise<string> {
  const safeRoleName = roleName.replace(/[^a-zA-Z0-9_\-]/g, ""); // Защита от path traversal
  if (!safeRoleName) {
    try {
      const generalPath = path.join(SERVER_ROOT, "profiles", "general.md");
      return await fs.readFile(generalPath, "utf-8");
    } catch {
      return `Роль: Консультант. Ответь на следующий вопрос:\n`;
    }
  }
  const profilePath = path.join(SERVER_ROOT, "profiles", `${safeRoleName}.md`);

  try {
    return await fs.readFile(profilePath, "utf-8");
  } catch (err) {
    process.stderr.write(`Предупреждение: Профиль роли '${roleName}' не найден по пути ${profilePath}. Будет использован общий профиль.\n`);
    
    // Попытка загрузить general.md
    try {
      const generalPath = path.join(SERVER_ROOT, "profiles", "general.md");
      return await fs.readFile(generalPath, "utf-8");
    } catch {
      return `Роль: Консультант. Ответь на следующий вопрос:\n`;
    }
  }
}

/**
 * Загружает промпт для указанного характера из папки profiles/personalities
 */
export async function loadPersonalityPrompt(personalityId: string): Promise<string> {
  const safeName = personalityId.replace(/[^a-zA-Z0-9_\-]/g, ""); // Защита от path traversal
  if (!safeName) {
    return "";
  }
  const profilePath = path.join(SERVER_ROOT, "profiles", "personalities", `${safeName}.md`);

  try {
    return await fs.readFile(profilePath, "utf-8");
  } catch (err) {
    process.stderr.write(`Предупреждение: Профиль характера '${personalityId}' не найден по пути ${profilePath}.\n`);
    return "";
  }
}

import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { randomUUID } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Корень самого MCP-сервера (где лежит исполняемый код и config.json)
export const SERVER_ROOT = path.resolve(__dirname, "..");

// Скрытая папка в домашней директории пользователя для изолированных HOME-директорий агентов
export const AGENT_HOMES_ROOT = path.join(os.homedir(), ".agent-consult", "homes");

// Активное рабочее пространство пользователя (текущий проект)
// Берем из переменной окружения CLAUDE_PROJECT_DIR or process.cwd()
export const WORKSPACE_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

export interface AgentConfig {
  model: string;
  system_prefix?: string;
  reasoning?: {
    enable: boolean;
    reasoning_effort?: "low" | "medium" | "high";
  };
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
}

let cachedConfig: AppConfig | null = null;

export function invalidateConfigCache(): void {
  cachedConfig = null;
}

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
    }
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

export const LOCAL_AGENTS = ["codex", "claude", "agy", "gemini", "mimo", "grok"];

export function getAgentHome(agentName: string, sessionId?: string): string {
  const safeAgentName = agentName.replace(/[^a-zA-Z0-9_\-]/g, "");
  if (!safeAgentName) {
    throw new Error(`Forbidden or invalid agentName: '${agentName}'`);
  }
  let homePath: string;
  if (sessionId) {
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_\-]/g, "");
    if (!safeSessionId) {
      throw new Error(`Invalid or unsafe sessionId: '${sessionId}'`);
    }
    homePath = path.join(AGENT_HOMES_ROOT, "sessions", safeSessionId, safeAgentName);
  } else {
    homePath = path.join(AGENT_HOMES_ROOT, safeAgentName);
  }
  const resolved = path.resolve(homePath);
  const resolvedRoot = path.resolve(AGENT_HOMES_ROOT);
  const relative = path.relative(resolvedRoot, resolved);
  const isInside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!isInside) {
    throw new Error(`Path traversal detected: agentName '${agentName}' or sessionId '${sessionId}' escapes AGENT_HOMES_ROOT`);
  }
  return resolved;
}

export async function atomicWriteFile(filePath: string, content: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(dir, `${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    const options = typeof content === "string"
      ? { encoding: "utf-8" as const, mode: 0o600 }
      : { mode: 0o600 };
    await fs.writeFile(tmpPath, content, options);
    await fs.rename(tmpPath, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (err: unknown) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export function sanitizeLogMessage(message: string): string {
  if (typeof message !== "string") return message;
  
  return message
    .replace(/(sk-or-v1-[a-zA-Z0-9]{64})/g, "[REDACTED_OPENROUTER_KEY]")
    .replace(/(sk-[a-zA-Z0-9]{20,})/g, "[REDACTED_API_KEY]")
    .replace(/(Authorization:\s*Bearer\s+)[a-zA-Z0-9_\-\.]+/ig, "$1[REDACTED_TOKEN]")
    .replace(/"(password|token|apiKey|secret)":\s*"[^"]+"/ig, '"$1": "[REDACTED]"');
}

export async function copyCredentialSafe(src: string, dest: string): Promise<void> {
  let fd: fs.FileHandle | null = null;
  try {
    // Используем O_RDONLY и O_NOFOLLOW для блокирования следования по симлинкам на уровне ядра
    fd = await fs.open(src, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await fd.stat();
    if (stat.isFile()) {
      const content = await fd.readFile();
      await atomicWriteFile(dest, content);
    }
  } catch (err: any) {
    if (err.code === "ENOENT" || err.code === "ELOOP") {
      // ELOOP означает, что файл является символической ссылкой
      return;
    }
    throw err;
  } finally {
    if (fd) {
      await fd.close().catch(() => {});
    }
  }
}

const ROLE_MCP_MAPPING: Record<string, string[]> = {
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

function escapeTomlString(val: string): string {
  return val
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\x08/g, "\\b")
    .replace(/\x0c/g, "\\f")
    .replace(/[\x00-\x07\x0b\x0e-\x1f]/g, (c) => {
      return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
    });
}

async function setupGrokConfig(agentHome: string, role: string): Promise<void> {
  const GLOBAL_HOME = os.homedir();
  const globalClaudeJsonPath = path.join(GLOBAL_HOME, ".claude.json");
  const targetGrokConfig = path.join(agentHome, ".grok", "config.toml");

  try {
    let globalJson: any = {};
    try {
      const globalData = await fs.readFile(globalClaudeJsonPath, "utf-8");
      globalJson = JSON.parse(globalData);
    } catch (err) {
      // Игнорируем
    }

    let tomlContent = `[cli]\ninstaller = "internal"\n\n[models]\ndefault = "grok-composer-2.5-fast"\n\n`;

    const allowedServers = ROLE_MCP_MAPPING[role] || ROLE_MCP_MAPPING["general"];

    for (const serverName of allowedServers) {
      let serverConfig = globalJson.mcpServers?.[serverName];
      if (!serverConfig) {
        if (serverName === "repowise") {
          serverConfig = {
            command: path.join(GLOBAL_HOME, ".local", "bin", "repowise-mcp"),
            args: ["mcp"]
          };
        } else if (serverName === "gitnexus") {
          serverConfig = {
            url: process.env.GITNEXUS_URL || "http://127.0.0.1:9401/api/mcp"
          };
        }
      }

      if (serverConfig) {
        tomlContent += `[mcp_servers.${serverName}]\n`;
        if (serverConfig.command) {
          tomlContent += `command = "${escapeTomlString(serverConfig.command)}"\n`;
          if (serverConfig.args) {
            tomlContent += `args = [${serverConfig.args.map((a: string) => `"${escapeTomlString(a)}"`).join(", ")}]\n`;
          }
        } else if (serverConfig.url) {
          tomlContent += `url = "${escapeTomlString(serverConfig.url)}"\n`;
        }
        tomlContent += `enabled = true\n\n`;

        if (serverConfig.headers && Object.keys(serverConfig.headers).length > 0) {
          let hasHeaders = false;
          let headersToml = `[mcp_servers.${serverName}.headers]\n`;
          for (const [hk, hv] of Object.entries(serverConfig.headers)) {
            if (/^[a-zA-Z0-9_\-]+$/.test(hk)) {
              const hkLower = hk.toLowerCase();
              if (hkLower.includes("key") || hkLower.includes("token") || hkLower.includes("auth") || hkLower.includes("secret") || hkLower.includes("password")) {
                continue;
              }
              headersToml += `${hk} = "${escapeTomlString(String(hv))}"\n`;
              hasHeaders = true;
            }
          }
          if (hasHeaders) {
            tomlContent += headersToml + `\n`;
          }
        }

        if (serverConfig.env && Object.keys(serverConfig.env).length > 0) {
          let hasEnv = false;
          let envToml = `[mcp_servers.${serverName}.env]\n`;
          for (const [ek, ev] of Object.entries(serverConfig.env)) {
            if (/^[a-zA-Z0-9_\-]+$/.test(ek)) {
              const ekLower = ek.toLowerCase();
              if (ekLower.includes("key") || ekLower.includes("token") || ekLower.includes("auth") || ekLower.includes("secret") || ekLower.includes("password")) {
                continue;
              }
              envToml += `${ek} = "${escapeTomlString(String(ev))}"\n`;
              hasEnv = true;
            }
          }
          if (hasEnv) {
            tomlContent += envToml + `\n`;
          }
        }
      }
    }

    await atomicWriteFile(targetGrokConfig, tomlContent);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Ошибка настройки config.toml для grok: ${msg}\n`);
  }
}

export async function setupAgentMcpConfig(agentName: string, role: string, sessionId?: string): Promise<void> {
  const agentHome = getAgentHome(agentName, sessionId);
  const resolvedHome = path.resolve(agentHome);
  const resolvedRoot = path.resolve(AGENT_HOMES_ROOT);
  if (!resolvedHome.startsWith(resolvedRoot)) {
    throw new Error(`Path traversal detected: agentName '${agentName}' escapes AGENT_HOMES_ROOT`);
  }
  
  if (agentName === "grok") {
    await setupGrokConfig(agentHome, role);
    return;
  }
  
  const targetClaudeJson = path.join(agentHome, ".claude.json");
  const GLOBAL_HOME = os.homedir();
  const globalClaudeJsonPath = path.join(GLOBAL_HOME, ".claude.json");

  try {
    // 1. Пытаемся прочитать глобальный .claude.json
    let globalJson: any = {};
    try {
      const globalData = await fs.readFile(globalClaudeJsonPath, "utf-8");
      globalJson = JSON.parse(globalData);
    } catch (err) {
      // Игнорируем
    }

    // 2. Создаем базовую конфигурацию для агента на основе глобальной (без mcpServers и permissions)
    const agentJson: any = {
      numStartups: globalJson.numStartups ?? 1,
      installMethod: globalJson.installMethod ?? "native",
      autoUpdates: globalJson.autoUpdates ?? false,
      theme: globalJson.theme ?? "light",
      userID: globalJson.userID,
      mcpServers: {},
      permissions: {
        allow: []
      }
    };

    // 3. Выбираем разрешенные серверы для данной роли
    const allowedServers = ROLE_MCP_MAPPING[role] || ROLE_MCP_MAPPING["general"];

    // 4. Настраиваем разрешенные серверы
    for (const serverName of allowedServers) {
      // Если сервер есть в глобальном конфиге, копируем его настройки с очисткой секретов
      if (globalJson.mcpServers && globalJson.mcpServers[serverName]) {
        const originalServer = globalJson.mcpServers[serverName];
        const serverCopy = JSON.parse(JSON.stringify(originalServer));
        
        if (serverCopy.headers) {
          for (const hk of Object.keys(serverCopy.headers)) {
            const hkLower = hk.toLowerCase();
            if (hkLower.includes("key") || hkLower.includes("token") || hkLower.includes("auth") || hkLower.includes("secret") || hkLower.includes("password")) {
              delete serverCopy.headers[hk];
            }
          }
        }
        
        if (serverCopy.env) {
          for (const ek of Object.keys(serverCopy.env)) {
            const ekLower = ek.toLowerCase();
            if (ekLower.includes("key") || ekLower.includes("token") || ekLower.includes("auth") || ekLower.includes("secret") || ekLower.includes("password")) {
              delete serverCopy.env[ek];
            }
          }
        }
        
        agentJson.mcpServers[serverName] = serverCopy;
      } else {
        // Дефолтные настройки для некоторых серверов
        if (serverName === "repowise") {
          agentJson.mcpServers["repowise"] = {
            type: "stdio",
            command: path.join(GLOBAL_HOME, ".local", "bin", "repowise-mcp"),
            args: ["mcp"]
          };
        } else if (serverName === "gitnexus") {
          agentJson.mcpServers["gitnexus"] = {
            type: "http",
            url: process.env.GITNEXUS_URL || "http://127.0.0.1:9401/api/mcp",
            headers: {}
          };
        }
      }

      // Добавляем разрешения для этого сервера
      agentJson.permissions.allow.push(`mcp/${serverName}`);
      agentJson.permissions.allow.push(`mcp/${serverName}/*`);
    }

    // 5. Добавляем разрешения на чтение файлов рабочей директории и папок навыков
    agentJson.permissions.allow.push(`read_file:${WORKSPACE_ROOT}`);
    agentJson.permissions.allow.push(`read_file:${WORKSPACE_ROOT}/*`);

    const globalSkillsDir = path.join(SERVER_ROOT, "skills");
    agentJson.permissions.allow.push(`read_file:${globalSkillsDir}`);
    agentJson.permissions.allow.push(`read_file:${globalSkillsDir}/*`);

    const agentSkillsDir = path.join(agentHome, "skills");
    agentJson.permissions.allow.push(`read_file:${agentSkillsDir}`);
    agentJson.permissions.allow.push(`read_file:${agentSkillsDir}/*`);

    // 6. Записываем файл .claude.json в домашнюю папку агента
    await atomicWriteFile(targetClaudeJson, JSON.stringify(agentJson, null, 2));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Ошибка настройки MCP для агента ${agentName} (роль: ${role}): ${msg}\n`);
    throw err;
  }
}

export async function ensureAgentHomeDirs(sessionId?: string): Promise<void> {
  // Создаем общую папку скиллов проекта
  const rootSkillsPath = path.join(SERVER_ROOT, "skills");
  try {
    await fs.mkdir(rootSkillsPath, { recursive: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Ошибка при создании корневой папки скиллов: ${msg}\n`);
  }

  // Создаем временную директорию для изолированных HOME-директорий агентов
  const safeSessionId = sessionId ? sessionId.replace(/[^a-zA-Z0-9_\-]/g, "") : "";
  const sessionsRoot = sessionId ? path.join(AGENT_HOMES_ROOT, "sessions", safeSessionId) : AGENT_HOMES_ROOT;
  const resolvedSessionsRoot = path.resolve(sessionsRoot);
  const resolvedHomesRoot = path.resolve(AGENT_HOMES_ROOT);
  const relativeSession = path.relative(resolvedHomesRoot, resolvedSessionsRoot);
  const isInsideSession = relativeSession === "" || (!relativeSession.startsWith("..") && !path.isAbsolute(relativeSession));
  if (!isInsideSession) {
    throw new Error(`Path traversal detected in ensureAgentHomeDirs: sessionId escapes AGENT_HOMES_ROOT`);
  }
  
  // Если инициализация глобальная на старте (без sessionId), чистим сессионные каталоги старше 24 часов (GC)
  if (!sessionId) {
    const sessionsGlobalDir = path.join(AGENT_HOMES_ROOT, "sessions");
    try {
      const items = await fs.readdir(sessionsGlobalDir).catch(() => [] as string[]);
      const now = Date.now();
      const maxAgeMs = 24 * 60 * 60 * 1000; // 24 часа

      for (const item of items) {
        const itemPath = path.join(sessionsGlobalDir, item);
        try {
          const stat = await fs.lstat(itemPath);
          if (stat.isDirectory() && !stat.isSymbolicLink()) {
            if (now - stat.mtimeMs > maxAgeMs) {
              await fs.rm(itemPath, { recursive: true, force: true });
            }
          }
        } catch (e) {
          // Игнорируем ошибки
        }
      }
    } catch (err) {
      // Игнорируем
    }
  }

  try {
    await fs.mkdir(resolvedSessionsRoot, { recursive: true });
    await fs.chmod(resolvedSessionsRoot, 0o700);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Ошибка при создании корневой папки агентов: ${msg}\n`);
  }

  const agents = ["codex", "claude", "agy", "gemini", "mimo", "grok", "synthesis"];
  for (const agent of agents) {
    const agentHomePath = getAgentHome(agent, sessionId);
    const agentSkillsPath = path.join(agentHomePath, "skills");
    try {
      await fs.mkdir(agentHomePath, { recursive: true });
      await fs.chmod(agentHomePath, 0o700);
      await fs.mkdir(agentSkillsPath, { recursive: true });
      await fs.chmod(agentSkillsPath, 0o700);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Ошибка при создании папок для ${agent}: ${msg}\n`);
    }
  }

  if (sessionId) {
    const GLOBAL_HOME = os.homedir();

    // Хелпер для копирования исключительно авторизационных токенов Claude
    const copyClaudeAuth = async (targetHome: string) => {
      await copyCredentialSafe(path.join(GLOBAL_HOME, ".claude", ".credentials.json"), path.join(targetHome, ".claude", ".credentials.json"));
      await copyCredentialSafe(path.join(GLOBAL_HOME, ".claude", ".credentials.current_backup.json"), path.join(targetHome, ".claude", ".credentials.current_backup.json"));
    };

    // Хелпер для копирования исключительно авторизационных токенов Gemini/Antigravity
    const copyGeminiAuth = async (targetHome: string) => {
      await copyCredentialSafe(path.join(GLOBAL_HOME, ".gemini", "oauth_creds.json"), path.join(targetHome, ".gemini", "oauth_creds.json"));
      await copyCredentialSafe(path.join(GLOBAL_HOME, ".gemini", "google_accounts.json"), path.join(targetHome, ".gemini", "google_accounts.json"));
      await copyCredentialSafe(path.join(GLOBAL_HOME, ".gemini", "installation_id"), path.join(targetHome, ".gemini", "installation_id"));
      await copyCredentialSafe(path.join(GLOBAL_HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token"), path.join(targetHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"));

      // Генерируем чистый settings.json с авторизацией oauth-personal и выключенным наследованием
      const targetSettingsPath = path.join(targetHome, ".gemini", "settings.json");
      const settingsContent = JSON.stringify({
        "security": {
          "auth": {
            "selectedType": "oauth-personal"
          }
        },
        "customizationDiscovery": {
          "agents": {
            "inheritUser": false,
            "allowFileDiscovery": false
          },
          "skills": {
            "inheritUser": false,
            "allowFileDiscovery": false
          },
          "mcp": {
            "inheritUser": false,
            "allowFileDiscovery": false
          }
        },
        "customizationDiscoveryConfig": {
          "agents": {
            "inheritUser": false,
            "allowFileDiscovery": false
          },
          "skills": {
            "inheritUser": false,
            "allowFileDiscovery": false
          },
          "mcp": {
            "inheritUser": false,
            "allowFileDiscovery": false
          }
        }
      }, null, 2);
      try {
        await atomicWriteFile(targetSettingsPath, settingsContent);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Ошибка генерации settings.json для ${targetHome}: ${msg}\n`);
      }
    };

    // 1. Для codex (чистый минимальный конфиг + авторизация)
    const codexHome = getAgentHome("codex", sessionId);
    await copyCredentialSafe(path.join(GLOBAL_HOME, ".codex", "auth.json"), path.join(codexHome, ".codex", "auth.json"));
    await copyCredentialSafe(path.join(GLOBAL_HOME, ".codex", "installation_id"), path.join(codexHome, ".codex", "installation_id"));
    await copyClaudeAuth(codexHome);
    
    // Генерируем чистый минимальный config.toml для Codex
    const codexConfigPath = path.join(codexHome, ".codex", "config.toml");
    const codexConfigContent = `model = "gpt-5.5"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n`;
    try {
      await atomicWriteFile(codexConfigPath, codexConfigContent);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Ошибка генерации config.toml для Codex: ${msg}\n`);
    }

    // 2. Для claude (только авторизация)
    const claudeHome = getAgentHome("claude", sessionId);
    await copyClaudeAuth(claudeHome);

    // 3. Для agy (только авторизация + чистый конфиг модели)
    const agyHome = getAgentHome("agy", sessionId);
    await copyGeminiAuth(agyHome);
    const agyConfigPath = path.join(agyHome, ".config", "antigravity", "config.toml");
    try {
      await atomicWriteFile(agyConfigPath, `model = "gemini-3.5-flash"\n`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Ошибка генерации config.toml для Agy: ${msg}\n`);
    }

    // 4. Для gemini (только авторизация + чистый конфиг модели)
    const geminiHome = getAgentHome("gemini", sessionId);
    await copyGeminiAuth(geminiHome);
    const geminiConfigPath = path.join(geminiHome, ".config", "antigravity", "config.toml");
    try {
      await atomicWriteFile(geminiConfigPath, `model = "gemini-2.5-pro"\n`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Ошибка генерации config.toml для Gemini: ${msg}\n`);
    }

    // 5. Для mimo (только авторизация + чистый config.json)
    const mimoHome = getAgentHome("mimo", sessionId);
    await copyClaudeAuth(mimoHome);
    const mimoConfigPath = path.join(mimoHome, ".config", "mimocode", "mimocode.json");
    const mimoConfigContent = JSON.stringify({
      "$schema": "https://opencode.ai/config.json",
      "permission": {
        "external_directory": "deny",
        "doom_loop": "deny"
      }
    }, null, 2);
    try {
      await atomicWriteFile(mimoConfigPath, mimoConfigContent);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Ошибка генерации mimocode.json для Mimo: ${msg}\n`);
    }

    // 6. Для grok (только авторизация + чистый config.toml)
    const copyGrokAuth = async (targetHome: string) => {
      await copyCredentialSafe(path.join(GLOBAL_HOME, ".grok", "auth.json"), path.join(targetHome, ".grok", "auth.json"));
      await copyCredentialSafe(path.join(GLOBAL_HOME, ".grok", "agent_id"), path.join(targetHome, ".grok", "agent_id"));
    };
    const grokHome = getAgentHome("grok", sessionId);
    await copyGrokAuth(grokHome);
    const grokConfigPath = path.join(grokHome, ".grok", "config.toml");
    const grokConfigContent = `[cli]\ninstaller = "internal"\n\n[models]\ndefault = "grok-composer-2.5-fast"\n`;
    try {
      await atomicWriteFile(grokConfigPath, grokConfigContent);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Ошибка генерации config.toml для Grok: ${msg}\n`);
    }
  }
}

/**
 * Синхронизирует токены/файлы авторизации агентов из изолированной сессионной директории
 * обратно в глобальный домашний каталог пользователя (на хост) для предотвращения их потери при обновлении.
 */
export async function syncAgentCredentialsBack(sessionId: string): Promise<void> {
  const GLOBAL_HOME = os.homedir();

  // Хелпер копирования исключительно авторизационных токенов Claude
  const syncClaudeAuth = async (targetHome: string) => {
    await copyCredentialSafe(path.join(targetHome, ".claude", ".credentials.json"), path.join(GLOBAL_HOME, ".claude", ".credentials.json"));
    await copyCredentialSafe(path.join(targetHome, ".claude", ".credentials.current_backup.json"), path.join(GLOBAL_HOME, ".claude", ".credentials.current_backup.json"));
  };

  // Хелпер копирования исключительно авторизационных токенов Gemini/Antigravity
  const syncGeminiAuth = async (targetHome: string) => {
    await copyCredentialSafe(path.join(targetHome, ".gemini", "oauth_creds.json"), path.join(GLOBAL_HOME, ".gemini", "oauth_creds.json"));
    await copyCredentialSafe(path.join(targetHome, ".gemini", "google_accounts.json"), path.join(GLOBAL_HOME, ".gemini", "google_accounts.json"));
    await copyCredentialSafe(path.join(targetHome, ".gemini", "installation_id"), path.join(GLOBAL_HOME, ".gemini", "installation_id"));
    await copyCredentialSafe(path.join(targetHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"), path.join(GLOBAL_HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token"));
  };

  try {
    // 1. Для codex
    const codexHome = getAgentHome("codex", sessionId);
    await copyCredentialSafe(path.join(codexHome, ".codex", "auth.json"), path.join(GLOBAL_HOME, ".codex", "auth.json"));
    await copyCredentialSafe(path.join(codexHome, ".codex", "installation_id"), path.join(GLOBAL_HOME, ".codex", "installation_id"));
    await syncClaudeAuth(codexHome);

    // 2. Для claude
    const claudeHome = getAgentHome("claude", sessionId);
    await syncClaudeAuth(claudeHome);

    // 3. Для agy
    const agyHome = getAgentHome("agy", sessionId);
    await syncGeminiAuth(agyHome);

    // 4. Для gemini
    const geminiHome = getAgentHome("gemini", sessionId);
    await syncGeminiAuth(geminiHome);

    // 5. Для mimo
    const mimoHome = getAgentHome("mimo", sessionId);
    await syncClaudeAuth(mimoHome);

    // 6. Для grok
    const grokHome = getAgentHome("grok", sessionId);
    await copyCredentialSafe(path.join(grokHome, ".grok", "auth.json"), path.join(GLOBAL_HOME, ".grok", "auth.json"));
    await copyCredentialSafe(path.join(grokHome, ".grok", "agent_id"), path.join(GLOBAL_HOME, ".grok", "agent_id"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[Config] Ошибка при обратной синхронизации токенов: ${msg}\n`);
  }
}

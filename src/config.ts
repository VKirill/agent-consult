import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";

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

/**
 * Загружает конфигурацию из файла config.json и переменных окружения
 */
export async function loadConfig(): Promise<AppConfig> {
  const configPath = path.join(SERVER_ROOT, "config.json");
  let fileConfig: Partial<AppConfig> = {};

  try {
    const data = await fs.readFile(configPath, "utf-8");
    fileConfig = JSON.parse(data);
  } catch (err: any) {
    process.stderr.write(`Предупреждение: Не удалось прочитать config.json (${err.message}). Будут использованы значения по умолчанию.\n`);
  }

  // Приоритет у переменной окружения
  const apiKey = process.env.OPENROUTER_API_KEY || fileConfig.openrouter_api_key || "";

  const config: AppConfig = {
    openrouter_api_key: apiKey,
    openrouter_referer: fileConfig.openrouter_referer ?? "https://github.com/modelcontextprotocol/agent-consult",
    openrouter_title: fileConfig.openrouter_title ?? "Agent Consult MCP Server",
    timeout_ms: fileConfig.timeout_ms ?? 120000,
    retry_attempts: fileConfig.retry_attempts ?? 2,
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

  return config;
}

/**
 * Загружает промпт для указанной роли из папки profiles
 */
export async function loadRolePrompt(roleName: string): Promise<string> {
  const safeRoleName = roleName.replace(/[^a-zA-Z0-9_\-]/g, ""); // Защита от path traversal
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
  const profilePath = path.join(SERVER_ROOT, "profiles", "personalities", `${safeName}.md`);

  try {
    return await fs.readFile(profilePath, "utf-8");
  } catch (err) {
    process.stderr.write(`Предупреждение: Профиль характера '${personalityId}' не найден по пути ${profilePath}.\n`);
    return "";
  }
}

async function copyFileSafe(src: string, dest: string, mode?: number): Promise<void> {
  try {
    const stat = await fs.stat(src);
    if (stat.isFile()) {
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await fs.copyFile(src, dest);
      if (mode !== undefined) {
        try {
          await fs.chmod(dest, mode);
        } catch (chmodErr) {
          // Игнорируем
        }
      }
    }
  } catch (err) {
    // Игнорируем если исходный файл не существует
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
          tomlContent += `command = "${serverConfig.command}"\n`;
          if (serverConfig.args) {
            tomlContent += `args = [${serverConfig.args.map((a: string) => `"${a}"`).join(", ")}]\n`;
          }
        } else if (serverConfig.url) {
          tomlContent += `url = "${serverConfig.url}"\n`;
        }
        tomlContent += `enabled = true\n\n`;

        if (serverConfig.headers && Object.keys(serverConfig.headers).length > 0) {
          tomlContent += `[mcp_servers.${serverName}.headers]\n`;
          for (const [hk, hv] of Object.entries(serverConfig.headers)) {
            tomlContent += `${hk} = "${hv}"\n`;
          }
          tomlContent += `\n`;
        }

        if (serverConfig.env && Object.keys(serverConfig.env).length > 0) {
          tomlContent += `[mcp_servers.${serverName}.env]\n`;
          for (const [ek, ev] of Object.entries(serverConfig.env)) {
            tomlContent += `${ek} = "${ev}"\n`;
          }
          tomlContent += `\n`;
        }
      }
    }

    await fs.mkdir(path.dirname(targetGrokConfig), { recursive: true, mode: 0o700 });
    await fs.writeFile(targetGrokConfig, tomlContent, "utf-8");
    try {
      await fs.chmod(targetGrokConfig, 0o600);
    } catch (e) {}
  } catch (err: any) {
    process.stderr.write(`Ошибка настройки config.toml для grok: ${err.message}\n`);
  }
}

export async function setupAgentMcpConfig(agentName: string, role: string): Promise<void> {
  const agentHome = path.join(AGENT_HOMES_ROOT, agentName);
  
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
      // Если сервер есть в глобальном конфиге, копируем его настройки
      if (globalJson.mcpServers && globalJson.mcpServers[serverName]) {
        agentJson.mcpServers[serverName] = globalJson.mcpServers[serverName];
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
    await fs.mkdir(path.dirname(targetClaudeJson), { recursive: true, mode: 0o700 });
    await fs.writeFile(targetClaudeJson, JSON.stringify(agentJson, null, 2), "utf-8");
    try {
      await fs.chmod(targetClaudeJson, 0o600);
    } catch (e) {}
  } catch (err: any) {
    process.stderr.write(`Ошибка настройки MCP для агента ${agentName} (роль: ${role}): ${err.message}\n`);
  }
}

export async function ensureAgentHomeDirs(): Promise<void> {
  // Создаем общую папку скиллов проекта
  const rootSkillsPath = path.join(SERVER_ROOT, "skills");
  try {
    await fs.mkdir(rootSkillsPath, { recursive: true });
  } catch (err: any) {
    process.stderr.write(`Ошибка при создании корневой папки скиллов: ${err.message}\n`);
  }

  // Создаем временную директорию для изолированных HOME-директорий агентов
  try {
    await fs.mkdir(AGENT_HOMES_ROOT, { recursive: true, mode: 0o700 });
  } catch (err: any) {
    process.stderr.write(`Ошибка при создании корневой временной папки агентов: ${err.message}\n`);
  }

  const agents = ["codex", "claude", "agy", "gemini", "mimo", "grok", "synthesis"];
  for (const agent of agents) {
    const agentHomePath = path.join(AGENT_HOMES_ROOT, agent);
    const agentSkillsPath = path.join(agentHomePath, "skills");
    try {
      await fs.mkdir(agentHomePath, { recursive: true, mode: 0o700 });
      await fs.mkdir(agentSkillsPath, { recursive: true, mode: 0o700 });
    } catch (err: any) {
      process.stderr.write(`Ошибка при создании папок для ${agent}: ${err.message}\n`);
    }
  }

  const GLOBAL_HOME = os.homedir();

  // Хелпер для копирования исключительно авторизационных токенов Claude
  const copyClaudeAuth = async (targetHome: string) => {
    await copyFileSafe(path.join(GLOBAL_HOME, ".claude", ".credentials.json"), path.join(targetHome, ".claude", ".credentials.json"), 0o600);
    await copyFileSafe(path.join(GLOBAL_HOME, ".claude", ".credentials.current_backup.json"), path.join(targetHome, ".claude", ".credentials.current_backup.json"), 0o600);
  };

  // Хелпер для копирования исключительно авторизационных токенов Gemini/Antigravity
  const copyGeminiAuth = async (targetHome: string) => {
    await copyFileSafe(path.join(GLOBAL_HOME, ".gemini", "oauth_creds.json"), path.join(targetHome, ".gemini", "oauth_creds.json"), 0o600);
    await copyFileSafe(path.join(GLOBAL_HOME, ".gemini", "google_accounts.json"), path.join(targetHome, ".gemini", "google_accounts.json"), 0o600);
    await copyFileSafe(path.join(GLOBAL_HOME, ".gemini", "installation_id"), path.join(targetHome, ".gemini", "installation_id"), 0o600);
    await copyFileSafe(path.join(GLOBAL_HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token"), path.join(targetHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"), 0o600);

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
      await fs.mkdir(path.dirname(targetSettingsPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(targetSettingsPath, settingsContent, "utf-8");
      try {
        await fs.chmod(targetSettingsPath, 0o600);
      } catch (e) {}
    } catch (err: any) {
      process.stderr.write(`Ошибка генерации settings.json для ${targetHome}: ${err.message}\n`);
    }
  };

  // 1. Для codex (чистый минимальный конфиг + авторизация)
  const codexHome = path.join(AGENT_HOMES_ROOT, "codex");
  await copyFileSafe(path.join(GLOBAL_HOME, ".codex", "auth.json"), path.join(codexHome, ".codex", "auth.json"), 0o600);
  await copyFileSafe(path.join(GLOBAL_HOME, ".codex", "installation_id"), path.join(codexHome, ".codex", "installation_id"), 0o600);
  await copyClaudeAuth(codexHome);
  
  // Генерируем чистый минимальный config.toml для Codex
  const codexConfigPath = path.join(codexHome, ".codex", "config.toml");
  const codexConfigContent = `model = "gpt-5.5"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n`;
  try {
    await fs.mkdir(path.dirname(codexConfigPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(codexConfigPath, codexConfigContent, "utf-8");
    try {
      await fs.chmod(codexConfigPath, 0o600);
    } catch (e) {}
  } catch (err: any) {
    process.stderr.write(`Ошибка генерации config.toml для Codex: ${err.message}\n`);
  }

  // 2. Для claude (только авторизация)
  const claudeHome = path.join(AGENT_HOMES_ROOT, "claude");
  await copyClaudeAuth(claudeHome);

  // 3. Для agy (только авторизация + чистый конфиг модели)
  const agyHome = path.join(AGENT_HOMES_ROOT, "agy");
  await copyGeminiAuth(agyHome);
  const agyConfigPath = path.join(agyHome, ".config", "antigravity", "config.toml");
  try {
    await fs.mkdir(path.dirname(agyConfigPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(agyConfigPath, `model = "gemini-3.5-flash"\n`, "utf-8");
    try {
      await fs.chmod(agyConfigPath, 0o600);
    } catch (e) {}
  } catch (err: any) {
    process.stderr.write(`Ошибка генерации config.toml для Agy: ${err.message}\n`);
  }

  // 4. Для gemini (только авторизация + чистый конфиг модели)
  const geminiHome = path.join(AGENT_HOMES_ROOT, "gemini");
  await copyGeminiAuth(geminiHome);
  const geminiConfigPath = path.join(geminiHome, ".config", "antigravity", "config.toml");
  try {
    await fs.mkdir(path.dirname(geminiConfigPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(geminiConfigPath, `model = "gemini-2.5-pro"\n`, "utf-8");
    try {
      await fs.chmod(geminiConfigPath, 0o600);
    } catch (e) {}
  } catch (err: any) {
    process.stderr.write(`Ошибка генерации config.toml для Gemini: ${err.message}\n`);
  }

  // 5. Для mimo (только авторизация + чистый config.json)
  const mimoHome = path.join(AGENT_HOMES_ROOT, "mimo");
  await copyClaudeAuth(mimoHome);
  const mimoConfigPath = path.join(mimoHome, ".config", "mimocode", "mimocode.json");
  const mimoConfigContent = JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    "permission": {
      "external_directory": "allow",
      "doom_loop": "allow"
    }
  }, null, 2);
  try {
    await fs.mkdir(path.dirname(mimoConfigPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(mimoConfigPath, mimoConfigContent, "utf-8");
    try {
      await fs.chmod(mimoConfigPath, 0o600);
    } catch (e) {}
  } catch (err: any) {
    process.stderr.write(`Ошибка генерации mimocode.json для Mimo: ${err.message}\n`);
  }

  // 6. Для grok (только авторизация + чистый config.toml)
  const copyGrokAuth = async (targetHome: string) => {
    await copyFileSafe(path.join(GLOBAL_HOME, ".grok", "auth.json"), path.join(targetHome, ".grok", "auth.json"), 0o600);
    await copyFileSafe(path.join(GLOBAL_HOME, ".grok", "agent_id"), path.join(targetHome, ".grok", "agent_id"), 0o600);
  };
  const grokHome = path.join(AGENT_HOMES_ROOT, "grok");
  await copyGrokAuth(grokHome);
  const grokConfigPath = path.join(grokHome, ".grok", "config.toml");
  const grokConfigContent = `[cli]\ninstaller = "internal"\n\n[models]\ndefault = "grok-composer-2.5-fast"\n`;
  try {
    await fs.mkdir(path.dirname(grokConfigPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(grokConfigPath, grokConfigContent, "utf-8");
    try {
      await fs.chmod(grokConfigPath, 0o600);
    } catch (e) {}
  } catch (err: any) {
    process.stderr.write(`Ошибка генерации config.toml для Grok: ${err.message}\n`);
  }
}

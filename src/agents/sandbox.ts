import fs from "fs/promises";
import path from "path";
import { resolveGlobalHome, AGENT_HOMES_ROOT, WORKSPACE_ROOT, SERVER_ROOT } from "../core/paths.js";
import { loadConfig } from "../core/config.js";
import { atomicWriteFile, linkCredentialSafe } from "../utils/fs.js";
import { CODEX_CONSULT_SANDBOX_MODE, assertCodexSandboxMode } from "../core/constants.js";
import { cleanAndValidateModel } from "./cli/invocation.js";
import {
  McpServerConfig,
  ClaudeGlobalConfig,
  resolveMcpServerEntries,
  serializeMcpServersToml
} from "./config-writer.js";

interface AgentClaudeConfig {
  numStartups: number;
  installMethod: string;
  autoUpdates: boolean;
  theme: string;
  userID?: string;
  mcpServers: Record<string, McpServerConfig>;
  permissions: { allow: string[] };
}

// Отдельная (от хоста ~/.grok) стабильная grok-личность агента.
// Grok ротирует refresh-токен при обновлении; шаринг хостового токена с
// песочницей разлогинивал пользователя. Агент логинится сюда своим
// device-сеансом: HOME=GROK_IDENTITY_HOME grok login
export const GROK_IDENTITY_HOME = path.join(path.dirname(AGENT_HOMES_ROOT), "grok-identity");

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

// Единственный источник истины по моделям — config.json. Чистим
// провайдерский префикс под формат, который ждёт конкретный CLI в config.toml.
async function modelForAgent(agentName: string, fallback: string): Promise<string> {
  const config = await loadConfig();
  return cleanAndValidateModel(config.agents?.[agentName]?.model || fallback);
}

async function setupGrokConfig(agentHome: string, allowedServers: string[]): Promise<void> {
  const GLOBAL_HOME = resolveGlobalHome();
  const globalClaudeJsonPath = path.join(GLOBAL_HOME, ".claude.json");
  const targetGrokConfig = path.join(agentHome, ".grok", "config.toml");

  try {
    let globalJson: ClaudeGlobalConfig = {};
    try {
      const globalData = await fs.readFile(globalClaudeJsonPath, "utf-8");
      globalJson = JSON.parse(globalData);
    } catch (err) {
      // Игнорируем
    }

    const grokModel = await modelForAgent("grok", "xai/grok-composer-2.5-fast");
    let tomlContent = `[cli]\ninstaller = "internal"\n\n[models]\ndefault = "${grokModel}"\n\n`;
    const entries = resolveMcpServerEntries(allowedServers, globalJson, GLOBAL_HOME);
    tomlContent += serializeMcpServersToml(entries, "enabled = true");

    await atomicWriteFile(targetGrokConfig, tomlContent);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Ошибка настройки config.toml для grok: ${msg}\n`);
  }
}

async function setupCodexConfig(agentHome: string, allowedServers: string[]): Promise<void> {
  const GLOBAL_HOME = resolveGlobalHome();
  const globalClaudeJsonPath = path.join(GLOBAL_HOME, ".claude.json");
  const targetCodexConfig = path.join(agentHome, ".codex", "config.toml");

  try {
    let globalJson: ClaudeGlobalConfig = {};
    try {
      const globalData = await fs.readFile(globalClaudeJsonPath, "utf-8");
      globalJson = JSON.parse(globalData);
    } catch (err) {
      // Игнорируем
    }

    assertCodexSandboxMode(CODEX_CONSULT_SANDBOX_MODE);
    const codexModel = await modelForAgent("codex", "openai/gpt-5.5");
    let tomlContent = `model = "${codexModel}"\napproval_policy = "on-request"\nsandbox_mode = "${CODEX_CONSULT_SANDBOX_MODE}"\n\n`;
    const entries = resolveMcpServerEntries(allowedServers, globalJson, GLOBAL_HOME);
    tomlContent += serializeMcpServersToml(entries, "startup_timeout_sec = 30");

    await atomicWriteFile(targetCodexConfig, tomlContent);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Ошибка настройки config.toml для codex: ${msg}\n`);
  }
}

export async function setupAgentMcpConfig(agentName: string, role: string, sessionId?: string): Promise<void> {
  const agentHome = getAgentHome(agentName, sessionId);
  const resolvedHome = path.resolve(agentHome);
  const resolvedRoot = path.resolve(AGENT_HOMES_ROOT);
  if (!resolvedHome.startsWith(resolvedRoot)) {
    throw new Error(`Path traversal detected: agentName '${agentName}' escapes AGENT_HOMES_ROOT`);
  }
  
  const config = await loadConfig();
  const mapping = config.role_mcp_mapping || {};
  const allowedServers = mapping[role] || mapping["general"] || [];
  
  if (agentName === "grok") {
    await setupGrokConfig(agentHome, allowedServers);
    return;
  }
  
  if (agentName === "codex") {
    await setupCodexConfig(agentHome, allowedServers);
  }
  
  const targetClaudeJson = path.join(agentHome, ".claude.json");
  const GLOBAL_HOME = resolveGlobalHome();
  const globalClaudeJsonPath = path.join(GLOBAL_HOME, ".claude.json");

  try {
    // 1. Пытаемся прочитать глобальный .claude.json
    let globalJson: ClaudeGlobalConfig = {};
    try {
      const globalData = await fs.readFile(globalClaudeJsonPath, "utf-8");
      globalJson = JSON.parse(globalData);
    } catch (err) {
      // Игнорируем
    }

    // 2. Создаем базовую конфигурацию для агента на основе глобальной (без mcpServers и permissions)
    const agentJson: AgentClaudeConfig = {
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

    // 4. Настраиваем разрешенные серверы через единый резолвер (тот же, что у codex/grok)
    const entries = resolveMcpServerEntries(allowedServers, globalJson, GLOBAL_HOME);
    for (const { name, config } of entries) {
      agentJson.mcpServers[name] = config;
    }
    for (const serverName of allowedServers) {
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

  const agents = ["codex", "claude", "agy", "mimo", "grok", "synthesis"];
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
    const GLOBAL_HOME = resolveGlobalHome();

    // Хелпер для создания символических ссылок на авторизационные токены Claude
    const copyClaudeAuth = async (targetHome: string) => {
      await linkCredentialSafe(path.join(GLOBAL_HOME, ".claude", ".credentials.json"), path.join(targetHome, ".claude", ".credentials.json"));
      await linkCredentialSafe(path.join(GLOBAL_HOME, ".claude", ".credentials.current_backup.json"), path.join(targetHome, ".claude", ".credentials.current_backup.json"));
      await linkCredentialSafe(path.join(GLOBAL_HOME, ".claude.json"), path.join(targetHome, ".claude.json"));
    };

    // Хелпер для создания символических ссылок на авторизационные токены Gemini/Antigravity
    const copyGeminiAuth = async (targetHome: string) => {
      await linkCredentialSafe(path.join(GLOBAL_HOME, ".gemini", "oauth_creds.json"), path.join(targetHome, ".gemini", "oauth_creds.json"));
      await linkCredentialSafe(path.join(GLOBAL_HOME, ".gemini", "google_accounts.json"), path.join(targetHome, ".gemini", "google_accounts.json"));
      await linkCredentialSafe(path.join(GLOBAL_HOME, ".gemini", "installation_id"), path.join(targetHome, ".gemini", "installation_id"));
      await linkCredentialSafe(path.join(GLOBAL_HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token"), path.join(targetHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"));

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
    await linkCredentialSafe(path.join(GLOBAL_HOME, ".codex", "auth.json"), path.join(codexHome, ".codex", "auth.json"));
    await linkCredentialSafe(path.join(GLOBAL_HOME, ".codex", "installation_id"), path.join(codexHome, ".codex", "installation_id"));
    await copyClaudeAuth(codexHome);
    // config.toml для Codex НЕ пишем здесь: единственный владелец — setupCodexConfig
    // (иначе повторный вызов ensureAgentHomeDirs затирал бы MCP-секцию и sandbox_mode).

    // 2. Для claude (только авторизация)
    const claudeHome = getAgentHome("claude", sessionId);
    await copyClaudeAuth(claudeHome);

    // 3. Для agy (только авторизация + чистый конфиг модели)
    const agyHome = getAgentHome("agy", sessionId);
    await copyGeminiAuth(agyHome);
    const agyConfigPath = path.join(agyHome, ".config", "antigravity", "config.toml");
    try {
      const agyModel = await modelForAgent("agy", "google/gemini-3.5-flash");
      await atomicWriteFile(agyConfigPath, `model = "${agyModel}"\n`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Ошибка генерации config.toml для Agy: ${msg}\n`);
    }

    // (gemini-агент отключён — отдельный home не создаём)

    // 5. Для mimo (только авторизация + чистый config.json)
    const mimoHome = getAgentHome("mimo", sessionId);
    await copyClaudeAuth(mimoHome);
    // Ключ подписки mimocode (провайдер xiaomi, type api — не ротируется),
    // без него mimo-v2.5-pro отдаёт "Invalid API Key".
    await linkCredentialSafe(
      path.join(GLOBAL_HOME, ".local", "share", "mimocode", "auth.json"),
      path.join(mimoHome, ".local", "share", "mimocode", "auth.json")
    );
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
      // Источник — ОТДЕЛЬНАЯ grok-личность агента, НЕ хостовый ~/.grok,
      // иначе ротация токена в песочнице разлогинивает пользователя.
      await linkCredentialSafe(path.join(GROK_IDENTITY_HOME, ".grok", "auth.json"), path.join(targetHome, ".grok", "auth.json"));
      await linkCredentialSafe(path.join(GROK_IDENTITY_HOME, ".grok", "agent_id"), path.join(targetHome, ".grok", "agent_id"));
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

export async function syncAgentCredentialsBack(sessionId: string): Promise<void> {
  const GLOBAL_HOME = resolveGlobalHome();

  const syncClaudeAuth = async (targetHome: string) => {
    await linkCredentialSafe(path.join(targetHome, ".claude", ".credentials.json"), path.join(GLOBAL_HOME, ".claude", ".credentials.json"));
    await linkCredentialSafe(path.join(targetHome, ".claude", ".credentials.current_backup.json"), path.join(GLOBAL_HOME, ".claude", ".credentials.current_backup.json"));
  };

  const syncGeminiAuth = async (targetHome: string) => {
    await linkCredentialSafe(path.join(targetHome, ".gemini", "oauth_creds.json"), path.join(GLOBAL_HOME, ".gemini", "oauth_creds.json"));
    await linkCredentialSafe(path.join(targetHome, ".gemini", "google_accounts.json"), path.join(GLOBAL_HOME, ".gemini", "google_accounts.json"));
    await linkCredentialSafe(path.join(targetHome, ".gemini", "installation_id"), path.join(GLOBAL_HOME, ".gemini", "installation_id"));
    await linkCredentialSafe(path.join(targetHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"), path.join(GLOBAL_HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token"));
  };

  try {
    const codexHome = getAgentHome("codex", sessionId);
    await linkCredentialSafe(path.join(codexHome, ".codex", "auth.json"), path.join(GLOBAL_HOME, ".codex", "auth.json"));
    await linkCredentialSafe(path.join(codexHome, ".codex", "installation_id"), path.join(GLOBAL_HOME, ".codex", "installation_id"));
    await syncClaudeAuth(codexHome);

    const claudeHome = getAgentHome("claude", sessionId);
    await syncClaudeAuth(claudeHome);

    const agyHome = getAgentHome("agy", sessionId);
    await syncGeminiAuth(agyHome);

    const mimoHome = getAgentHome("mimo", sessionId);
    await syncClaudeAuth(mimoHome);

    const grokHome = getAgentHome("grok", sessionId);
    // Обратная синхронизация grok идёт в отдельную grok-личность агента,
    // НЕ в хостовый ~/.grok — хост-логин пользователя не трогаем.
    await linkCredentialSafe(path.join(grokHome, ".grok", "auth.json"), path.join(GROK_IDENTITY_HOME, ".grok", "auth.json"));
    await linkCredentialSafe(path.join(grokHome, ".grok", "agent_id"), path.join(GROK_IDENTITY_HOME, ".grok", "agent_id"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[Config] Ошибка при обратной синхронизации токенов: ${msg}\n`);
  }
}

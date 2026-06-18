import path from "path";

// Единый контракт MCP-серверной записи и его сериализация в форматы
// разных CLI (codex/grok — TOML, claude — JSON). Раньше эта логика была
// скопирована в трёх местах sandbox.ts, из-за чего баг с фильтрацией
// заголовка Authorization пришлось чинить трижды.

export interface McpServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface ClaudeGlobalConfig {
  mcpServers?: Record<string, McpServerConfig>;
  numStartups?: number;
  installMethod?: string;
  autoUpdates?: boolean;
  theme?: string;
  userID?: string;
  machineID?: string;
  oauthAccount?: unknown;
  [key: string]: unknown;
}

export interface ResolvedMcpServer {
  name: string;
  config: McpServerConfig;
}

export function escapeTomlString(val: string): string {
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

/**
 * Единая точка разрешения списка разрешённых MCP-серверов в конкретные
 * конфигурации. Берёт настройки из глобального .claude.json, а для
 * нескольких известных серверов подставляет дефолты. Заголовки/env
 * (включая Authorization) сохраняются как есть — фильтрации больше нет.
 */
export function resolveMcpServerEntries(
  allowedServers: string[],
  globalJson: ClaudeGlobalConfig,
  globalHome: string
): ResolvedMcpServer[] {
  const entries: ResolvedMcpServer[] = [];
  for (const name of allowedServers) {
    const present = globalJson.mcpServers?.[name];
    if (present) {
      entries.push({ name, config: JSON.parse(JSON.stringify(present)) });
    } else if (name === "repowise") {
      entries.push({
        name,
        config: {
          type: "stdio",
          command: path.join(globalHome, ".local", "bin", "repowise-mcp"),
          args: ["mcp"]
        }
      });
    } else if (name === "gitnexus") {
      entries.push({
        name,
        config: {
          type: "http",
          url: process.env.GITNEXUS_URL || "http://127.0.0.1:9401/api/mcp",
          headers: {}
        }
      });
    }
    // Прочие неизвестные серверы без глобальной записи пропускаем.
  }
  return entries;
}

function serializeTomlSubTable(
  serverName: string,
  table: "headers" | "env",
  obj?: Record<string, string>
): string {
  if (!obj || Object.keys(obj).length === 0) return "";
  let body = `[mcp_servers.${serverName}.${table}]\n`;
  let hasAny = false;
  for (const [k, v] of Object.entries(obj)) {
    if (/^[a-zA-Z0-9_\-]+$/.test(k)) {
      body += `${k} = "${escapeTomlString(String(v))}"\n`;
      hasAny = true;
    }
  }
  return hasAny ? body + "\n" : "";
}

/**
 * Сериализует MCP-серверы в TOML-формат codex/grok. Единственное отличие
 * между ними — строка-суффикс per-server (codex: startup_timeout_sec = 30,
 * grok: enabled = true).
 */
export function serializeMcpServersToml(
  entries: ResolvedMcpServer[],
  serverSuffixLine: string
): string {
  let out = "";
  for (const { name, config } of entries) {
    out += `[mcp_servers.${name}]\n`;
    if (config.command) {
      out += `command = "${escapeTomlString(config.command)}"\n`;
      if (config.args) {
        out += `args = [${config.args.map((a) => `"${escapeTomlString(a)}"`).join(", ")}]\n`;
      }
    } else if (config.url) {
      out += `url = "${escapeTomlString(config.url)}"\n`;
    }
    out += `${serverSuffixLine}\n\n`;
    out += serializeTomlSubTable(name, "headers", config.headers);
    out += serializeTomlSubTable(name, "env", config.env);
  }
  return out;
}

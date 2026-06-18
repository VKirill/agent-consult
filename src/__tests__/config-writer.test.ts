import { describe, it, expect } from "vitest";
import {
  resolveMcpServerEntries,
  serializeMcpServersToml,
  escapeTomlString,
  ClaudeGlobalConfig
} from "../agents/config-writer.js";

const globalJson: ClaudeGlobalConfig = {
  mcpServers: {
    gitnexus: {
      type: "http",
      url: "http://127.0.0.1:9401/api/mcp",
      headers: { Authorization: "Bearer secret-token" }
    },
    perplexity: {
      command: "node",
      args: ["/x/perplexity/index.js"]
    }
  }
};

describe("resolveMcpServerEntries", () => {
  it("берёт сервер из globalJson и сохраняет Authorization (главный инцидент)", () => {
    const [gn] = resolveMcpServerEntries(["gitnexus"], globalJson, "/home/u");
    expect(gn.config.headers?.Authorization).toBe("Bearer secret-token");
  });

  it("отдаёт глубокую копию, а не ссылку на исходник", () => {
    const [gn] = resolveMcpServerEntries(["gitnexus"], globalJson, "/home/u");
    expect(gn.config).not.toBe(globalJson.mcpServers!.gitnexus);
    expect(gn.config).toEqual(globalJson.mcpServers!.gitnexus);
  });

  it("подставляет дефолт для repowise/gitnexus, когда их нет в globalJson", () => {
    const entries = resolveMcpServerEntries(["repowise", "gitnexus"], {}, "/home/u");
    expect(entries.map((e) => e.name)).toEqual(["repowise", "gitnexus"]);
    expect(entries[0].config.command).toContain("repowise-mcp");
    expect(entries[1].config.url).toContain("9401");
  });

  it("пропускает неизвестный сервер без записи и без дефолта", () => {
    const entries = resolveMcpServerEntries(["unknown-xyz"], {}, "/home/u");
    expect(entries).toHaveLength(0);
  });

  it("сохраняет порядок allowedServers", () => {
    const entries = resolveMcpServerEntries(["perplexity", "gitnexus"], globalJson, "/home/u");
    expect(entries.map((e) => e.name)).toEqual(["perplexity", "gitnexus"]);
  });
});

describe("serializeMcpServersToml", () => {
  it("codex-суффикс и блок headers", () => {
    const entries = resolveMcpServerEntries(["gitnexus"], globalJson, "/home/u");
    const toml = serializeMcpServersToml(entries, "startup_timeout_sec = 30");
    expect(toml).toContain("[mcp_servers.gitnexus]");
    expect(toml).toContain('url = "http://127.0.0.1:9401/api/mcp"');
    expect(toml).toContain("startup_timeout_sec = 30");
    expect(toml).toContain("[mcp_servers.gitnexus.headers]");
    expect(toml).toContain('Authorization = "Bearer secret-token"');
  });

  it("grok-суффикс enabled = true и command/args", () => {
    const entries = resolveMcpServerEntries(["perplexity"], globalJson, "/home/u");
    const toml = serializeMcpServersToml(entries, "enabled = true");
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('args = ["/x/perplexity/index.js"]');
    expect(toml).toContain("enabled = true");
    expect(toml).not.toContain("headers");
  });

  it("отбрасывает заголовок с недопустимым именем", () => {
    const entries = [{ name: "x", config: { url: "u", headers: { "Bad Name": "v", Good: "w" } } }];
    const toml = serializeMcpServersToml(entries, "enabled = true");
    expect(toml).toContain('Good = "w"');
    expect(toml).not.toContain("Bad Name");
  });
});

describe("escapeTomlString", () => {
  it("экранирует кавычки и бэкслеши", () => {
    expect(escapeTomlString('a"b\\c')).toBe('a\\"b\\\\c');
  });
});

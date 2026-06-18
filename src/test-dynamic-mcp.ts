import { setupAgentMcpConfig, ensureAgentHomeDirs, AGENT_HOMES_ROOT, loadConfig, resolveGlobalHome } from "./config.js";
import fs from "fs/promises";
import path from "path";

async function testDynamicMcp() {
  console.log("=== ТЕСТ ДИНАМИЧЕСКИХ НАСТРОЕК MCP ПО РОЛЯМ ===");
  await ensureAgentHomeDirs();

  const testCases = [
    { role: "programmer", agent: "claude" },
    { role: "web_architect", agent: "codex" },
    { role: "marketer", agent: "mimo" }
  ];

  const config = await loadConfig();
  const mapping = config.role_mcp_mapping || {};

  const globalClaudeJsonPath = path.join(resolveGlobalHome(), ".claude.json");
  let globalServers: string[] = [];
  try {
    const globalData = await fs.readFile(globalClaudeJsonPath, "utf-8");
    const globalJson = JSON.parse(globalData);
    globalServers = Object.keys(globalJson.mcpServers || {});
  } catch (err) {
    // Игнорируем
  }

  const isServerAvailable = (name: string) => globalServers.includes(name) || name === "repowise" || name === "gitnexus";

  for (const tc of testCases) {
    console.log(`\nНастройка MCP для агента ${tc.agent} с ролью ${tc.role}...`);
    await setupAgentMcpConfig(tc.agent, tc.role);

    const configPath = path.join(AGENT_HOMES_ROOT, tc.agent, ".claude.json");
    const data = await fs.readFile(configPath, "utf-8");
    const json = JSON.parse(data);

    const servers = Object.keys(json.mcpServers || {});
    console.log(`Зарегистрированные MCP-серверы: [${servers.join(", ")}]`);

    const expected = (mapping[tc.role] || mapping["general"] || []).filter(isServerAvailable);

    const match = expected.every(s => servers.includes(s)) && servers.every(s => expected.includes(s));
    console.log(match ? `✅ Успешно: все настроенные на хосте MCP-серверы для роли ${tc.role} на месте!` : `❌ Ошибка соответствия для роли ${tc.role}! Ожидалось: [${expected.join(", ")}], получено: [${servers.join(", ")}]`);
  }

  console.log("\nТест динамического MCP успешно завершен!");
}

testDynamicMcp().catch(err => {
  console.error("Ошибка теста:", err);
});

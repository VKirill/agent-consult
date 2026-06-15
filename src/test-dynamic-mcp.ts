import { setupAgentMcpConfig, ensureAgentHomeDirs, AGENT_HOMES_ROOT } from "./config.js";
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

  for (const tc of testCases) {
    console.log(`\nНастройка MCP для агента ${tc.agent} с ролью ${tc.role}...`);
    await setupAgentMcpConfig(tc.agent, tc.role);

    const configPath = path.join(AGENT_HOMES_ROOT, tc.agent, ".claude.json");
    const data = await fs.readFile(configPath, "utf-8");
    const json = JSON.parse(data);

    const servers = Object.keys(json.mcpServers || {});
    console.log(`Зарегистрированные MCP-серверы: [${servers.join(", ")}]`);

    // Проверяем соответствие
    if (tc.role === "programmer") {
      const match = servers.includes("gitnexus") && servers.includes("repowise") && servers.length === 2;
      console.log(match ? "✅ Успешно: только gitnexus и repowise!" : "❌ Ошибка соответствия!");
    } else if (tc.role === "web_architect") {
      const match = servers.includes("gitnexus") && servers.includes("repowise") && servers.includes("vue-docs") && servers.includes("shadcn");
      console.log(match ? "✅ Успешно: фронтенд-серверы подключены!" : "❌ Ошибка соответствия!");
    } else if (tc.role === "marketer") {
      const match = servers.includes("perplexity") || servers.includes("tavily");
      console.log(match ? "✅ Успешно: маркетинговые инструменты поиска подключены!" : "❌ Ошибка соответствия!");
    }
  }

  console.log("\nТест динамического MCP успешно завершен!");
}

testDynamicMcp().catch(err => {
  console.error("Ошибка теста:", err);
});

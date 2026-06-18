import { loadConfig, ensureAgentHomeDirs } from "./config.js";
import { runConsultation } from "./consult-orchestrator.js";

async function pingAllCLI() {
  console.log("=== ЗАПУСК ПИНГА ЧЕРЕЗ ЛОКАЛЬНЫЕ CLI-ИНСТРУМЕНТЫ ===");
  await ensureAgentHomeDirs();
  const config = await loadConfig();

  const question = "Ответь ровно одним словом: PONG.";
  const agents = ["codex", "claude", "agy", "gemini", "mimo", "grok"];

  console.log(`Запускаем опрос через локальные CLI для агентов: ${agents.map(a => a.toUpperCase()).join(", ")}`);
  
  const startTime = Date.now();
  try {
    const res = await runConsultation({
      question,
      role: "general",
      agentsList: agents,
      skipSynthesis: true,
      config
    });

    const totalDurationSec = (Date.now() - startTime) / 1000;
    console.log(`\n=== РЕЗУЛЬТАТЫ ПИНГА ЛОКАЛЬНЫХ CLI (Всего: ${totalDurationSec.toFixed(2)} сек) ===`);
    console.log("| Агент | Модель | Статус | Задержка (сек) | Полученный ответ |");
    console.log("|---|---|---|---|---|");

    for (const agentName of agents) {
      const agentRes = res.agentResults.find(r => r.agentName === agentName);
      if (!agentRes) {
        console.log(`| ${agentName.toUpperCase().padEnd(7)} | ${"unknown".padEnd(30)} | ❌ ERR |        — | Нет ответа в результатах |`);
        continue;
      }

      const model = agentRes.model || "unknown";
      const statusStr = agentRes.success ? "✅ OK" : "❌ ERR";
      const durationStr = (agentRes.durationMs / 1000).toFixed(2);
      const answerSnippet = agentRes.content 
        ? agentRes.content.trim().replace(/\n/g, " ").substring(0, 30) 
        : (agentRes.error || "Нет ответа");

      console.log(`| ${agentName.toUpperCase().padEnd(7)} | ${model.padEnd(30)} | ${statusStr} | ${durationStr.padStart(8)} | ${answerSnippet.padEnd(30)} |`);
    }
  } catch (err: any) {
    console.error("Критическая ошибка при выполнении пинга CLI:", err.message);
  }
}

pingAllCLI().catch(console.error);

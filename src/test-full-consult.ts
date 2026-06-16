import { loadConfig, ensureAgentHomeDirs } from "./config.js";
import { runConsultation } from "./consult-orchestrator.js";

async function testFullConsult() {
  console.log("=== ТЕСТ ПОЛНОГО ЦИКЛА АГЕНТ КОНСАЛТ (ВСЕ 5 АГЕНТОВ + СИНТЕЗ) ===");
  await ensureAgentHomeDirs();
  const config = await loadConfig();
  const apiKey = config.openrouter_api_key;
  
  if (!apiKey || apiKey.includes("YOUR_")) {
    console.error("Ошибка: API-ключ не настроен.");
    process.exit(1);
  }

  const question = "Каковы 3 главных правила при проектировании API для мобильных приложений?";
  const role = "app_architect";
  const testAgents = ["codex", "claude", "agy", "gemini", "mimo", "grok"];

  console.log(`Вопрос: "${question}"`);
  console.log(`Роль: ${role}`);
  console.log(`Агенты: ${testAgents.join(", ")}`);
  console.log("Запуск оркестрации...");

  const startTime = Date.now();
  
  const result = await runConsultation({
    question,
    role,
    agentsList: testAgents,
    skipSynthesis: false,
    config
  });

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\nКонсилиум завершился за ${durationSec}с.`);
  
  if (!result.success) {
    console.error("❌ Оркестрация вернула ошибку!");
    console.error(result.outputMarkdown);
    process.exit(1);
  }

  console.log("\n✅ Все 5 агентов ответили, синтез выполнен успешно!");
  console.log("\n=== ИТОГОВЫЙ MARKDOWN (ФРАГМЕНТ) ===");
  // Выведем первые 1000 символов итогового отчета, чтобы не перегружать лог
  console.log(result.outputMarkdown.substring(0, 1500) + "\n...\n[truncated]");
}

testFullConsult().catch(err => {
  console.error("Критическая ошибка теста:", err);
});

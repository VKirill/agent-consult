import { loadConfig, ensureAgentHomeDirs } from "../dist/config.js";
import { runConsultation } from "../dist/consult-orchestrator.js";

async function testFullConsult() {
  console.log("=== ТЕСТ ПОЛНОГО ЦИКЛА АГЕНТ КОНСАЛТ (ВСЕ 5 АГЕНТОВ + СИНТЕЗ) ===");
  await ensureAgentHomeDirs();
  const config = await loadConfig();
  const apiKey = config.openrouter_api_key;
  
  if (!apiKey || apiKey.includes("YOUR_")) {
    console.error("Ошибка: API-ключ не настроен.");
    process.exit(1);
  }

  const question = `Проанализируйте архитектуру нашего проекта agent-consult (особенно файлы src/config.ts и src/consult-orchestrator.ts) на предмет уязвимостей, узких мест производительности и потенциальных точек отказа (SPoF).
Предложите улучшения по следующим критическим направлениям:
1. Управление жизненным циклом и ресурсами локальных CLI-процессов: Как гарантированно предотвратить утечки зомби-процессов в ОС при аварийном завершении оркестратора или таймаутах, и как оптимизировать пул параллельно запускаемых CLI.
2. Отказоустойчивость синтеза: Как изменить логику runConsultation, чтобы при падении модели синтезатора пользователь всё равно получал сырые ответы успешно отработавших агентов вместо общей ошибки.
3. Безопасность и изоляция песочниц: Как гарантировать, что один локальный агент через свои инструменты чтения/запуска команд не сможет получить доступ к приватным токенам авторизации (.credentials.json, auth.json) других агентов, лежащих в ~/.agent-consult/homes/`;
  const role = "system_architect";
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

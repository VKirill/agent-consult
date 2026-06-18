import { loadConfig, loadRolePrompt, ensureAgentHomeDirs } from "../dist/config.js";
import { checkOpenRouterLiveness } from "../dist/openrouter-client.js";

async function test() {
  console.log("=== ИНИЦИАЛИЗАЦИЯ И КОПИРОВАНИЕ НАСТРОЕК ===");
  await ensureAgentHomeDirs();
  console.log("Настройки успешно скопированы во изолированные домашние директории.");

  console.log("=== ТЕСТИРОВАНИЕ КОНФИГУРАЦИИ ===");
  const config = await loadConfig();
  console.log("Загруженная конфигурация:");
  console.log(`Таймаут: ${config.timeout_ms}мс`);
  console.log(`Попыток ретрая: ${config.retry_attempts}`);
  console.log(`Модель Codex: ${config.agents.codex.model}`);
  console.log(`Модель Claude: ${config.agents.claude.model}`);
  console.log(`Модель Synthesis: ${config.synthesis.model}`);

  console.log("\n=== ТЕСТИРОВАНИЕ ПРОФИЛЕЙ РОЛЕЙ ===");
  const marketerPrompt = await loadRolePrompt("marketer");
  console.log("Промпт маркетолога (первые 150 символов):");
  console.log(marketerPrompt.substring(0, 150) + "...");

  const programmerPrompt = await loadRolePrompt("programmer");
  console.log("\nПромпт программиста (первые 150 символов):");
  console.log(programmerPrompt.substring(0, 150) + "...");

  console.log("\n=== ТЕСТИРОВАНИЕ ПОДКЛЮЧЕНИЯ (БЕЗ КЛЮЧА) ===");
  const liveness = await checkOpenRouterLiveness(config.openrouter_api_key);
  console.log(`OpenRouter доступен: ${liveness.ok ? "Да" : `Нет (${liveness.reason})`}`);
  
  console.log("\nТестирование локальных компонентов успешно завершено!");
}

test().catch(err => {
  console.error("Ошибка при тестировании:", err);
  process.exit(1);
});

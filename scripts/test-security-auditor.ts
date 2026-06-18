import { loadConfig } from "../dist/config.js";
import { runConsultation } from "../dist/consult-orchestrator.js";

async function testSecurityAuditor() {
  console.log("=== ТЕСТИРОВАНИЕ РОЛИ SECURITY_AUDITOR ===");
  const config = await loadConfig();
  const apiKey = config.openrouter_api_key;
  
  if (!apiKey || apiKey.includes("YOUR_")) {
    console.error("Ошибка: API-ключ не настроен.");
    process.exit(1);
  }

  const question = 
    "Выполни краткий аудит безопасности для функции хеширования пароля: " +
    "const hash = crypto.createHash('md5').update(password).digest('hex'); " +
    "Укажи уязвимости и предложи безопасную альтернативу.";
    
  const role = "security_auditor";
  
  // Мы запускаем консультацию для роли security_auditor.
  // Логика должна автоматически использовать только одного агента 'codex',
  // переопределить модель на gpt-5.5 и включить reasoning_effort = high.
  console.log(`Запуск для роли: "${role}"`);
  console.log(`Вопрос: "${question}"\n`);
  console.log("Ожидается запуск только агента CODEX с reasoning_effort = high...");

  const result = await runConsultation({
    question,
    role,
    agentsList: ["codex"],
    skipSynthesis: true, // Для 1 агента синтез автоматически пропускается
    config
  });

  if (!result.success) {
    console.error("❌ Ошибка выполнения запроса!");
    console.error(result.outputMarkdown);
    process.exit(1);
  }

  console.log("\n=== РЕЗУЛЬТАТЫ ОТВЕТА АГЕНТА ===");
  
  for (const res of result.agentResults) {
    console.log(`\n🤖 Агент: ${res.agentName.toUpperCase()} (${res.model})`);
    console.log(`Характер: ${res.personality || "Обычный"}`);
    console.log("--------------------------------------------------");
    if (res.success && res.content) {
      console.log(res.content);
    } else {
      console.log(`Ошибка: ${res.error}`);
    }
  }
}

testSecurityAuditor().catch(err => {
  console.error("Критическая ошибка:", err);
});

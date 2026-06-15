import { loadConfig } from "./config.js";
import { runConsultation } from "./consult-orchestrator.js";

async function testSkillsCheck() {
  console.log("=== ПРОВЕРКА ИЗОЛЯЦИИ: ЗАПРОС О ДОСТУПЕ К СКИЛЛАМ ===");
  const config = await loadConfig();
  const apiKey = config.openrouter_api_key;
  
  if (!apiKey || apiKey.includes("YOUR_")) {
    console.error("Ошибка: API-ключ не настроен.");
    process.exit(1);
  }

  const question = 
    "Откуда ты читаешь свои скиллы (skills)? Есть ли у тебя в доступе какие-то локальные скиллы, " +
    "файлы в папке /home/ubuntu/.gemini/antigravity-cli/skills или другие локальные инструменты хоста? " +
    "Ответь честно, видишь ли ты что-то за пределами своего контекста.";
    
  const role = "general";
  const testAgents = ["codex", "claude", "agy", "gemini", "mimo"];

  console.log(`Вопрос: "${question}"\n`);
  console.log("Запуск оркестрации...");

  const result = await runConsultation({
    question,
    role,
    agentsList: testAgents,
    skipSynthesis: false, // Нам также интересен вывод Minimax
    config
  });

  if (!result.success) {
    console.error("❌ Ошибка выполнения запроса!");
    console.error(result.outputMarkdown);
    process.exit(1);
  }

  console.log("\n=== РЕЗУЛЬТАТЫ ОТВЕТОВ АГЕНТОВ ===");
  
  for (const res of result.agentResults) {
    console.log(`\n🤖 Агент: ${res.agentName.toUpperCase()} (${res.model})`);
    console.log("--------------------------------------------------");
    if (res.success && res.content) {
      console.log(res.content);
    } else {
      console.log(`Ошибка: ${res.error}`);
    }
  }

  if (result.synthesisSuccess && result.synthesisContent) {
    console.log("\n🧠 СИНТЕЗ ОТВЕТОВ (Minimax-M3):");
    console.log("--------------------------------------------------");
    console.log(result.synthesisContent);
  }
}

testSkillsCheck().catch(err => {
  console.error("Критическая ошибка:", err);
});

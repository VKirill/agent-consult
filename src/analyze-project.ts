import { loadConfig, ensureAgentHomeDirs } from "./config.js";
import { runConsultation } from "./consult-orchestrator.js";
import fs from "fs/promises";
import path from "path";

async function runAnalysis() {
  console.log("=== ИНИЦИАЛИЗАЦИЯ АГЕНТ КОНСАЛТ ДЛЯ АНАЛИЗА СОБСТВЕННОГО ПРОЕКТА ===");
  await ensureAgentHomeDirs();
  const config = await loadConfig();

  const question = 
    "Проведи глубокий технический аудит и анализ кода текущего проекта (MCP-сервер agent-consult).\n" +
    "Проанализируй структуру и исходный код файлов:\n" +
    "1. src/index.ts\n" +
    "2. src/config.ts\n" +
    "3. src/consult-orchestrator.ts\n" +
    "4. src/openrouter-client.ts\n\n" +
    "Найди баги, проблемы безопасности, слабые места и предложи конкретные улучшения в плане:\n" +
    "- Оптимизации производительности и ввода-вывода (IO)\n" +
    "- Чистоты кода и соответствия лучшим практикам TypeScript/ESM\n" +
    "- Обработки ошибок и управления процессами\n" +
    "- Использования MCP-инструментов, таких как gitnexus и repowise.\n\n" +
    "Ответь структурировано на русском языке. Для каждого замечания укажи файл, характер проблемы (P0/P1/P2) и код до/после.";

  const role = "programmer";
  const testAgents = ["codex", "claude", "agy", "gemini", "mimo"];

  console.log(`Запуск консилиума для анализа проекта...`);
  
  const startTime = Date.now();
  const result = await runConsultation({
    question,
    role,
    agentsList: testAgents,
    skipSynthesis: false,
    config
  });
  
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\nАнализ завершился за ${durationSec}с.`);

  const outputPath = path.join(process.cwd(), "project-analysis-report.md");
  await fs.writeFile(outputPath, result.outputMarkdown, "utf-8");
  
  console.log(`\n✅ Отчет успешно сохранен в файл: ${outputPath}`);
}

runAnalysis().catch(err => {
  console.error("Ошибка при проведении анализа:", err);
  process.exit(1);
});

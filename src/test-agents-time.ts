import { loadConfig, ensureAgentHomeDirs } from "./config.js";
import { runConsultation } from "./consult-orchestrator.js";

const question = `Как отрефакторить функцию \`queryLocalCLI\` в файле \`src/consult-orchestrator.ts\` нашего проекта для улучшения стабильности и производительности?
Предложи улучшения по следующим направлениям:
1. Оптимизация работы с таймерами (сейчас там два setTimeout и сложная логика resetOrExtendTimeout).
2. Безопасность временных файлов промптов для grok (гарантированное удаление при любых сбоях, обработка ошибок удаления).
3. Переход от \`exec\` к \`spawn\` (где применимо) или оптимизация стриминга stderr/stdout.
Опиши архитектурные изменения и приведи пример улучшенного кода на TypeScript.`;

async function benchmark() {
  console.log("=== ЗАПУСК БЕНЧМАРКА АГЕНТОВ ===");
  console.log("Инициализируем окружение...");
  await ensureAgentHomeDirs();
  const config = await loadConfig();

  const agents = ["codex", "claude", "agy", "gemini", "mimo", "grok"];
  const results: Record<string, { durationSec: number; success: boolean; snippet: string }> = {};

  for (const agent of agents) {
    console.log(`\n--------------------------------------------------`);
    console.log(`🚀 [Запуск] Опрашиваем агента: ${agent.toUpperCase()}...`);
    
    const startTime = Date.now();
    try {
      const res = await runConsultation({
        question,
        role: "programmer",
        agentsList: [agent],
        skipSynthesis: true,
        config
      });

      const durationSec = (Date.now() - startTime) / 1000;
      console.log(`⏱️  [Завершено] Агент ${agent.toUpperCase()} ответил за ${durationSec.toFixed(2)} сек.`);
      
      const agentRes = res.agentResults[0];
      const snippet = agentRes && agentRes.content 
        ? agentRes.content.trim().substring(0, 400) + "\n..."
        : "Нет текста ответа";

      results[agent] = {
        durationSec,
        success: res.success && !!agentRes?.success,
        snippet
      };
    } catch (err: any) {
      const durationSec = (Date.now() - startTime) / 1000;
      console.error(`❌ [Ошибка] Агент ${agent.toUpperCase()} упал через ${durationSec.toFixed(2)} сек: ${err.message}`);
      results[agent] = {
        durationSec,
        success: false,
        snippet: `Ошибка: ${err.message}`
      };
    }
  }

  console.log("\n\n==================================================");
  console.log("=== РЕЗУЛЬТАТЫ БЕНЧМАРКА ===");
  console.log("==================================================");
  console.log("| Агент | Время (сек) | Статус | Модель |");
  console.log("|-------|-------------|--------|--------|");
  for (const agent of agents) {
    const r = results[agent];
    const model = config.agents[agent]?.model || "unknown";
    console.log(`| ${agent.toUpperCase().padEnd(7)} | ${r.durationSec.toFixed(2).padStart(11)} | ${r.success ? "✅ OK  " : "❌ ERR "} | ${model.padEnd(25)} |`);
  }

  console.log("\n=== ФРАГМЕНТЫ ОТВЕТОВ ДЛЯ ОЦЕНКИ КАЧЕСТВА ===");
  for (const agent of agents) {
    console.log(`\n🤖 Агент: ${agent.toUpperCase()}`);
    console.log(`Ответ:\n${results[agent].snippet}`);
    console.log(`--------------------------------------------------`);
  }
}

benchmark().catch(err => {
  console.error("Критическая ошибка бенчмарка:", err);
});

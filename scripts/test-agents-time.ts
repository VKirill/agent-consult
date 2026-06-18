import { loadConfig, ensureAgentHomeDirs } from "../dist/config.js";
import { runConsultation } from "../dist/consult-orchestrator.js";

const question = `Как оптимизировать обработку ошибок и ретраи при сетевых сбоях или таймаутах OpenRouter API в модуле \`src/openrouter-client.ts\` нашего проекта?
Предложи улучшения по следующим направлениям:
1. Использование механизма Exponential Backoff с джиттером для ретраев при ошибках 429 (Rate Limit) и временных сетевых сбоях (502, 503, 504).
2. Определение автоматического списка резервных моделей-синтезаторов (например, google/gemini-2.5-flash как fallback), если minimax/minimax-m3 возвращает ошибку или недоступен.
3. Реализация AbortSignal для корректной отмены сетевых запросов при таймауте на уровне axios/fetch.
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

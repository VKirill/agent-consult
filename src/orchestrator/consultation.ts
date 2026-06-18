import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { randomUUID } from "crypto";

import { AppConfig, AgentConfig, loadRolePrompt } from "../core/config.js";
import { AGENT_HOMES_ROOT, resolveGlobalHome } from "../core/paths.js";
import { LOCAL_AGENTS, PERSONALITIES } from "../core/constants.js";
import { ensureAgentHomeDirs } from "../agents/sandbox.js";
import { isLocalAgentAvailable, runAgent, activeSessionDirs } from "../agents/runner.js";
import { queryOpenRouter, AgentResponse } from "../openrouter-client.js";

export interface ConsultationResult {
  success: boolean;
  outputMarkdown: string;
  agentResults: AgentResponse[];
  synthesisSuccess: boolean;
  synthesisContent?: string;
  synthesisError?: string;
  totalDurationMs: number;
}

/**
 * Оркестрирует опрос группы агентов и последующий синтез ответов
 */
export async function runConsultation(options: {
  question: string;
  role: string;
  customRolePrompt?: string;
  agentsList: string[];
  skipSynthesis: boolean;
  config: AppConfig;
}): Promise<ConsultationResult> {
  const { question, role, customRolePrompt, agentsList: rawAgentsList, skipSynthesis, config } = options;
  const agentsList = [...new Set(rawAgentsList)];

  // Валидация входных параметров от Prompt Injection и Resource Exhaustion
  if (question && question.length > 100000) {
    throw new Error("Вопрос превышает допустимый лимит 100000 символов.");
  }
  if (customRolePrompt && customRolePrompt.length > 4000) {
    throw new Error("Кастомный промпт роли превышает допустимый лимит 4000 символов.");
  }

  const apiKey = config.openrouter_api_key;
  const startTime = Date.now();
  const sessionId = randomUUID();
  const sessionHomeDir = path.join(AGENT_HOMES_ROOT, "sessions", sessionId);
  activeSessionDirs.add(sessionHomeDir);

  // Создаем папку логов сессии
  const logsDir = path.join(resolveGlobalHome(), ".agent-consult", "logs");
  await fs.mkdir(logsDir, { recursive: true }).catch(() => {});
  const logFilePath = path.join(logsDir, `consultation_${sessionId}.log`);

  // Записываем заголовок в файл лога синхронно для избежания состояния гонки с логированием агентов
  try {
    fsSync.writeFileSync(logFilePath, `[${new Date().toISOString()}] [SYSTEM] Старт консилиума. SessionID: ${sessionId}\nВопрос: ${question}\nРоль: ${role}\nАгенты: ${agentsList.join(", ")}\n--------------------------------------------------\n`, { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    // Игнорируем
  }

  // 1. Определение промпта роли
  let rolePrompt = "";
  if (customRolePrompt) {
    rolePrompt = customRolePrompt;
  } else {
    rolePrompt = await loadRolePrompt(role);
  }

  // Перемешиваем характеры для распределения между агентами (Fisher-Yates shuffle)
  const shuffledPersonalities = [...PERSONALITIES];
  for (let i = shuffledPersonalities.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = shuffledPersonalities[i];
    shuffledPersonalities[i] = shuffledPersonalities[j];
    shuffledPersonalities[j] = temp;
  }

  // 2. Параллельный запуск агентов с отслеживанием прогресса в реальном времени
  const activeAgents = new Set(agentsList);
  let completedCount = 0;

  const progressTimer = setInterval(() => {
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stderr.write(`[Consult Orchestrator] Ожидаем ответы от агентов: ${Array.from(activeAgents).map(a => a.toUpperCase()).join(", ")} (прошло ${elapsedSec} сек)\n`);
  }, 10000);

  let agentResults: AgentResponse[] = [];

  try {
    // Синхронизируем директории и актуальные сессионные токены агентов перед каждым запуском консилиума в изолированной папке
    await ensureAgentHomeDirs(sessionId);

    const agentPromises = agentsList.map(async (agentName, index) => {
      let agentConfig = config.agents[agentName];
      if (!agentConfig) {
        activeAgents.delete(agentName);
        return {
          agentName,
          model: "unknown",
          success: false,
          error: `Агент с именем '${agentName}' не найден в конфигурации.`,
          durationMs: 0
        } as AgentResponse;
      }

      if (LOCAL_AGENTS.includes(agentName) && !isLocalAgentAvailable(agentName)) {
        activeAgents.delete(agentName);
        process.stderr.write(`[Consult Orchestrator] Локальный агент ${agentName.toUpperCase()} выключен: исполняемый файл не найден в системе.\n`);
        return {
          agentName,
          model: agentConfig.model,
          success: false,
          error: `Локальный агент '${agentName}' не установлен на этой машине. Опрос пропущен.`,
          durationMs: 0
        } as AgentResponse;
      }

      if (role === "security_auditor" && agentName === "codex") {
        agentConfig = {
          ...agentConfig,
          model: "openai/gpt-5.5",
          reasoning: {
            enable: true,
            reasoning_effort: "high"
          }
        };
      }

      // Назначаем характер по кругу из перемешанного списка
      const personality = shuffledPersonalities[index % shuffledPersonalities.length];
      
      try {
        const res = await runAgent(
          agentName,
          agentConfig,
          role,
          rolePrompt,
          question,
          apiKey,
          config.timeout_ms,
          config.retry_attempts,
          config.openrouter_referer,
          config.openrouter_title,
          personality,
          sessionId,
          logFilePath
        );
        
        completedCount++;
        activeAgents.delete(agentName);
        process.stderr.write(`[Consult Orchestrator] [${completedCount}/${agentsList.length}] Агент ${agentName.toUpperCase()} (${res.personality || "Без характера"}) завершил работу за ${(res.durationMs / 1000).toFixed(1)} сек с результатом: ${res.success ? "✅ Успешно" : "❌ Ошибка"}\n`);
        return res;
      } catch (err: any) {
        completedCount++;
        activeAgents.delete(agentName);
        process.stderr.write(`[Consult Orchestrator] [${completedCount}/${agentsList.length}] Агент ${agentName.toUpperCase()} завершился критической ошибкой: ${err.message || String(err)}\n`);
        return {
          agentName,
          model: agentConfig.model,
          success: false,
          error: err.message || String(err),
          durationMs: Date.now() - startTime,
          personality: personality ? personality.name : undefined
        } as AgentResponse;
      }
    });

    agentResults = await Promise.all(agentPromises);
  } finally {
    clearInterval(progressTimer);
    process.stderr.write(`[Consult Orchestrator] Обратная синхронизация токенов отключена из соображений безопасности.\n`);

    // Гарантированно очищаем изолированную сессионную директорию агентов
    const sessionHomeDir = path.join(AGENT_HOMES_ROOT, "sessions", sessionId);
    try {
      await fs.rm(sessionHomeDir, { recursive: true, force: true });
      activeSessionDirs.delete(sessionHomeDir);
    } catch (rmErr: any) {
      process.stderr.write(`[Consult Orchestrator] Не удалось удалить сессионную директорию ${sessionHomeDir}: ${rmErr.message}\n`);
    }
  }

  const successfulResponses = agentResults.filter(r => r.success && r.content);

  // Если никто не ответил, возвращаем ошибку
  if (successfulResponses.length === 0) {
    let errText = "### Ошибка опроса агентов\n\nНи один из агентов не смог вернуть ответ. Ошибки:\n";
    for (const res of agentResults) {
      errText += `- **${res.agentName.toUpperCase()}**: ${res.error}\n`;
    }
    return {
      success: false,
      outputMarkdown: errText,
      agentResults,
      synthesisSuccess: false,
      totalDurationMs: Date.now() - startTime
    };
  }

  let synthesisContent = "";
  let synthesisSuccess = false;
  let synthesisError = "";

  // 3. Синтез (самореализация) через Minimax-M3
  if (!skipSynthesis && successfulResponses.length > 0) {
    let agentsReport = `Исходный вопрос: <source_question>${question}</source_question>\n\n`;
    agentsReport += `Роль специалиста: "${role}"\n\n`;
    
    agentsReport += `Сводка работы агентов (Summary):\n`;
    for (const res of agentResults) {
      agentsReport += `- Агент ${res.agentName.toUpperCase()} (${res.model}): ${res.success ? `✅ Успешно за ${(res.durationMs / 1000).toFixed(2)}с` : `❌ Ошибка: ${res.error}`}\n`;
    }
    agentsReport += `\n`;
    
    agentsReport += `Ответы специализированных агентов:\n\n`;
    
    for (const res of successfulResponses) {
      agentsReport += `=== ОТВЕТ АГЕНТА: ${res.agentName.toUpperCase()} (Модель: ${res.model}, Характер: ${res.personality || "Обычный"}) ===\n`;
      agentsReport += `${res.content}\n\n`;
    }

    try {
      process.stderr.write(`[Consult Orchestrator] Запуск профессионального синтеза через ${config.synthesis.model}...\n`);
      
      let synthesisPrompt = "";
      try {
        synthesisPrompt = await loadRolePrompt("synthesis");
      } catch (err) {
        synthesisPrompt = config.synthesis.system_prefix || "Ты — Синтезатор Агент Консалт. Проведи профессиональную самореализацию и консолидируй ответы.";
      }

      synthesisContent = await queryOpenRouter(
        apiKey,
        config.synthesis.model,
        synthesisPrompt,
        agentsReport,
        config.synthesis,
        config.timeout_ms,
        config.retry_attempts,
        config.openrouter_referer,
        config.openrouter_title
      );
      synthesisSuccess = true;
    } catch (err: any) {
      process.stderr.write(`[Consult Orchestrator] Ошибка синтеза: ${err.message}\n`);
      synthesisSuccess = false;
      synthesisError = err.message || String(err);
    }
  }

  const totalDurationMs = Date.now() - startTime;

  if (logFilePath) {
    const timestamp = new Date().toISOString();
    let endSummary = `\n[${timestamp}] [SYSTEM] Завершение консилиума. SessionID: ${sessionId}\n`;
    endSummary += `Общая длительность: ${(totalDurationMs / 1000).toFixed(2)} сек.\n`;
    endSummary += `Сводка работы агентов:\n`;
    for (const res of agentResults) {
      endSummary += `- Агент ${res.agentName.toUpperCase()} (${res.model}): ${res.success ? `✅ Успешно за ${(res.durationMs / 1000).toFixed(2)} сек` : `❌ Ошибка: ${res.error}`}\n`;
    }
    if (!skipSynthesis) {
      endSummary += `Профессиональный синтез: ${synthesisSuccess ? "✅ Выполнен" : `❌ Ошибка: ${synthesisError}`}\n`;
    }
    endSummary += `--------------------------------------------------\n`;
    await fs.appendFile(logFilePath, endSummary).catch(() => {});
  }

  // 4. Формирование Markdown отчета
  let outputMarkdown = `# Результаты консилиума "Агент Консалт"\n\n`;
  outputMarkdown += `**Вопрос:** *${question}*\n`;
  outputMarkdown += `**Роль:** \`${role}\` | **Успешных агентов:** ${successfulResponses.length} из ${agentsList.length}\n\n`;

  if (!skipSynthesis) {
    outputMarkdown += `## 🧠 Профессиональный синтез (Самореализация через ${config.synthesis.model})\n\n`;
    if (synthesisSuccess) {
      outputMarkdown += `${synthesisContent}\n\n`;
    } else {
      outputMarkdown += `⚠️ *Не удалось выполнить синтез ответов из-за ошибки: ${synthesisError}*\n\n`;
    }
  }

  outputMarkdown += `## 👥 Детальные ответы агентов\n\n`;
  
  for (const res of agentResults) {
    outputMarkdown += `### 🤖 Агент: ${res.agentName.toUpperCase()} (${res.model})\n`;
    if (res.personality) {
      outputMarkdown += `- **Характер**: ${res.personality}\n`;
    }
    outputMarkdown += `- **Статус**: ${res.success ? "✅ Успешно" : "❌ Ошибка"}\n`;
    outputMarkdown += `- **Время ответа**: ${(res.durationMs / 1000).toFixed(2)} сек\n\n`;
    
    if (res.success && res.content) {
      outputMarkdown += `<details>\n<summary><b>Посмотреть детальный ответ агента ${res.agentName.toUpperCase()}</b></summary>\n\n${res.content}\n</details>\n\n`;
    } else {
      outputMarkdown += `<details>\n<summary><b>Посмотреть текст ошибки</b></summary>\n\n\`\`\`\n${res.error}\n\`\`\`\n</details>\n\n`;
    }
    outputMarkdown += `---\n\n`;
  }

  outputMarkdown += `*Общее время работы консилиума: ${(totalDurationMs / 1000).toFixed(2)} сек.*\n`;

  return {
    success: true,
    outputMarkdown: outputMarkdown.trim(),
    agentResults,
    synthesisSuccess,
    synthesisContent: synthesisSuccess ? synthesisContent : undefined,
    synthesisError: synthesisSuccess ? undefined : synthesisError,
    totalDurationMs
  };
}

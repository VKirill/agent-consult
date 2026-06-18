import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, loadRolePrompt, ensureAgentHomeDirs, LOCAL_AGENTS, sanitizeLogMessage } from "./config.js";
import { checkOpenRouterLiveness } from "./openrouter-client.js";
import { runConsultation, activeChildPids, activeSessionDirs } from "./consult-orchestrator.js";
import { spawn, spawnSync } from "child_process";
import fsSync from "fs";

// ── Глобальные обработчики ошибок ────────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  const cleanReason = sanitizeLogMessage(String(reason));
  process.stderr.write(`[Agent Consult] Unhandled Rejection: ${cleanReason}\n`);
});

process.on("uncaughtException", (err) => {
  const cleanStack = sanitizeLogMessage(err?.stack || String(err));
  process.stderr.write(`[Agent Consult] Uncaught Exception: ${cleanStack}\n`);
  cleanupAllChildren();
  process.exit(1);
});

// ── Простая реализация Семафора для ограничения параллелизма ──────────────
export class Semaphore {
  private active = 0;
  private queue: { resolve: () => void; reject: (err: Error) => void; timeout?: NodeJS.Timeout }[] = [];

  constructor(
    private maxConcurrency: number,
    private maxQueueSize = 20,
    private queueTimeoutMs = 60000
  ) {
    if (!Number.isFinite(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("maxConcurrency must be a positive integer");
    }
    if (!Number.isFinite(maxQueueSize) || maxQueueSize < 0) {
      throw new Error("maxQueueSize must be a non-negative integer");
    }
    if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs < 0) {
      throw new Error("queueTimeoutMs must be non-negative");
    }
  }

  async acquire(): Promise<void> {
    if (this.active < 0 || this.active > this.maxConcurrency) {
      throw new Error(`Нарушение инварианта Semaphore: active count (${this.active}) вне диапазона [0, ${this.maxConcurrency}]`);
    }

    if (this.active < this.maxConcurrency) {
      this.active++;
      return;
    }

    if (this.queue.length >= this.maxQueueSize) {
      throw new Error(`Очередь семафора переполнена: превышен лимит в ${this.maxQueueSize} запросов.`);
    }

    return new Promise<void>((resolve, reject) => {
      const queueItem: { resolve: () => void; reject: (err: Error) => void; timeout?: NodeJS.Timeout } = {
        resolve,
        reject
      };

      const timeout = setTimeout(() => {
        const index = this.queue.indexOf(queueItem);
        if (index !== -1) {
          this.queue.splice(index, 1);
          reject(new Error(`Превышен таймаут ожидания в очереди семафора (${this.queueTimeoutMs} мс).`));
        }
      }, this.queueTimeoutMs);

      queueItem.timeout = timeout;
      this.queue.push(queueItem);
    });
  }

  release(): void {
    if (this.active <= 0) {
      throw new Error(`Нарушение инварианта Semaphore: попытка вызвать release при active count = ${this.active}`);
    }

    this.active--;

    const next = this.queue.shift();
    if (next) {
      if (next.timeout) {
        clearTimeout(next.timeout);
      }
      this.active++;
      next.resolve();
    }
  }

  getActiveCount(): number {
    return this.active;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  updateLimits(maxConcurrency: number, maxQueueSize: number, queueTimeoutMs: number): void {
    if (!Number.isFinite(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("maxConcurrency must be a positive integer");
    }
    if (!Number.isFinite(maxQueueSize) || maxQueueSize < 0) {
      throw new Error("maxQueueSize must be a non-negative integer");
    }
    if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs < 0) {
      throw new Error("queueTimeoutMs must be non-negative");
    }
    this.maxConcurrency = maxConcurrency;
    this.maxQueueSize = maxQueueSize;
    this.queueTimeoutMs = queueTimeoutMs;
  }
}

const consultSemaphore = new Semaphore(3, 20, 60000);

// Создаем инстанс сервера
const server = new Server(
  {
    name: "agent-consult",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {
        listChanged: false,
      },
    },
    instructions:
      "This MCP server provides access to the collective mind of 6 agents (Codex, Claude, Anti-Gravity (agy), Gemini, Mimo, Grok). " +
      "When calling the consultation (ask_consultant), the parent agent MUST act as a qualified Senior/Tech Lead: " +
      "translate the end-user's informal request into a structured technical brief in Russian, " +
      "pre-gathering the project context (reading relevant files, schemas, or directory structures via your own tools first) " +
      "so that the council of agents receives comprehensive information for deep analysis. " +
      "IMPORTANT: Every consultation call is completely stateless. The council of agents does not remember previous sessions or questions. " +
      "If you make a follow-up or secondary question (e.g. after code modifications), you MUST include the updated file contents and full context again. " +
      "Never assume agents remember past calls.",
  }
);

// ── Реализация ListTools ─────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "ask_consultant",
        title: "Request agent consultation",
        description: 
          "Sends a complex technical or business question to a group of 5 specialized AI agents (Codex, Claude, agy, Mimo, Grok) " +
          "simultaneously. Each agent responds according to their selected role (e.g. programmer, marketer, architect). " +
          "After gathering individual opinions, the Minimax-M3 synthesis model is launched to consolidate the responses, " +
          "identify unique ideas, resolve contradictions, and compile a single structured Markdown report.",
        inputSchema: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: 
                "DETAILED TECHNICAL BRIEF. The parent agent must translate the user's informal or unstructured " +
                "question into a professional technical specification. Formulate a comprehensive brief in Russian, including: " +
                "1) The essence of the task/problem in professional terms. " +
                "2) Project context (architecture, stack, constraints, relevant code snippets/schemas read from the host). " +
                "3) Expected analysis results. " +
                "Never send short one-line queries. Enrich the question with technical details of the project. " +
                "IMPORTANT: Every consultation is completely stateless. The agents do not remember previous questions. " +
                "When asking a follow-up or secondary question (e.g. after code modifications), you MUST include the updated file contents and full context again.",
            },
            role: {
              type: "string",
              enum: ["marketer", "programmer", "system_architect", "web_architect", "app_architect", "security_auditor", "qa_engineer", "data_engineer", "general"],
              default: "general",
              description: 
                "Specialist profile determining the context and system instructions for the consultation. " +
                "marketer — marketing/USP/target audience; " +
                "programmer — code/refactoring/testing; " +
                "system_architect — servers/networking/DevOps/CI-CD; " +
                "web_architect — UX/UI/Core Web Vitals/technical SEO; " +
                "app_architect — application architecture/microservices/databases; " +
                "security_auditor — security audit/vulnerabilities/OWASP/secrets; " +
                "qa_engineer — test plans/edge cases/Vitest/Playwright; " +
                "data_engineer — database schemas/ETL/SQL optimization/OLAP; " +
                "general — general consultant.",
            },
            custom_role_prompt: {
              type: "string",
              description: 
                "Custom system prompt overriding the default instruction for the selected role. " +
                "Use this to specify a narrow specialization for the council on the fly.",
            },
            agents: {
              type: "array",
              items: {
                type: "string"
              },
              description: 
                "List of specific agents to query (e.g. ['codex', 'claude']). " +
                "Defaults to all 5 available agents: ['codex', 'claude', 'agy', 'mimo', 'grok'].",
            },
            request_raw_responses: {
              type: "boolean",
              default: true,
              description: 
                "По умолчанию (true), сервер возвращает детальные ответы от каждого агента отдельно без выполнения общего синтеза, " +
                "что позволяет получить полные, неискаженные ответы от всех участников консилиума. " +
                "Установите в false, если требуется запустить синтезатор для получения единого резюме.",
            }
          },
          required: ["question"],
        },
      },
      {
        name: "check_agents_status",
        title: "Check agents status and liveness",
        description: 
          "Performs system diagnostics. Validates the OpenRouter API key, checks network availability, " +
          "and optionally performs active ping (PONG) checks on all configured agents.",
        inputSchema: {
          type: "object",
          properties: {
            ping: {
              type: "boolean",
              description: "Если true, выполняет активный запуск (ping) каждого агента для проверки работоспособности и авторизации."
            }
          },
        },
      },
      {
        name: "list_available_roles",
        title: "List available roles",
        description: "Returns a detailed description of all supported specializations (roles) with their focus and strengths.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      }
    ],
  };
});

// ── Реализация CallTool ─────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // 1. Вывод доступных ролей
  if (name === "list_available_roles") {
    const rolesInfo = `
### Доступные профили специалистов в Агент Консалт:

1. **marketer** (Маркетолог-стратег):
   - **Фокус**: Позиционирование (Ries/Trout), дифференциация (Dunford), воронки (AARRR), потребности ЦА (JTBD).
   - **Рекомендуется для**: Запусков продуктов, формулирования УТП, анализа каналов продвижения.

2. **programmer** (Профессиональный программист):
   - **Фокус**: Чистый код, паттерны проектирования, алгоритмическая оптимизация, рефакторинг, автотесты.
   - **Рекомендуется для**: Написания алгоритмов, код-ревью, исправления багов.

3. **system_architect** (Системный архитектор инфраструктуры):
   - **Фокус**: Серверная инфраструктура, сети, CI/CD, оркестрация контейнеров (K8s/Docker), мониторинг (Prometheus), DevOps.
   - **Рекомендуется для**: Проектирования серверов, деплоя, автоматизации сборки и инфраструктурной надежности.

4. **web_architect** (Веб-архитектор / Проектировщик сайтов):
   - **Фокус**: Информационная архитектура сайта, UX-структура страниц, Schema.org, Core Web Vitals, доступность (WCAG).
   - **Рекомендуется для**: Проектирования структуры веб-сайтов, оптимизации воронки конверсий интерфейса.

5. **app_architect** (Архитектор сложных приложений):
   - **Фокус**: Распределенные системы, микросервисы, DDD, проектирование баз данных (репликация/шардирование по Клеппману), интеграции.
   - **Рекомендуется для**: Выбора стека, проектирования структуры БД, планирования отказоустойчивой архитектуры.

 6. **security_auditor** (Аудитор безопасности):
    - **Фокус**: Уязвимости (OWASP Top 10), инъекции, утечки секретов и приватных данных, зависимости, права доступа.
    - **Рекомендуется для**: Безопасного аудита кода и инфраструктуры, поиска утечек API-ключей, threat modeling.

 7. **qa_engineer** (Инженер по качеству):
    - **Фокус**: Сценарии тестирования (граничные условия, edge cases), тест-планы, фреймворки автотестов (Vitest, Playwright).
    - **Рекомендуется для**: Разработки стратегии автоматизации тестирования, верификации стабильности кода.

 8. **data_engineer** (Инженер данных):
    - **Фокус**: Проектирование схем баз данных (OLAP/OLTP), ETL пайплайны, оптимизация SQL-запросов (EXPLAIN ANALYZE), партиционирование.
    - **Рекомендуется для**: Выбора хранилищ, интеграции данных, рефакторинга миграций и оптимизации производительности БД.

 9. **general** (Универсальный консультант):
    - **Фокус**: Комплексный анализ вопросов, сравнение вариантов решений, пошаговое планирование, маршрутизация.
    - **Рекомендуется для**: Разноплановых задач, не попадающих под остальные категории.
`;
    return {
      content: [{ type: "text", text: rolesInfo.trim() }]
    };
  }

  // 2. Проверка статуса
  if (name === "check_agents_status") {
    const config = await loadConfig();
    const liveness = await checkOpenRouterLiveness(config.openrouter_api_key);
    const livenessLabel = liveness.ok
      ? "✅ Доступен"
      : liveness.reason === "missing_key"
        ? "❌ API-ключ не задан"
        : liveness.reason === "unauthorized"
          ? "❌ Неверный API-ключ"
          : "❌ Ошибка сети / подключения";
    const doActivePing = !!args?.ping;
    
    let statusText = `### Статус MCP-сервера "Агент Консалт":\n\n`;
    statusText += `- **Связь с OpenRouter**: ${livenessLabel}\n`;
    statusText += `- **Таймаут по умолчанию**: ${config.timeout_ms} мс (${config.timeout_ms / 1000} сек)\n`;
    statusText += `- **Количество попыток (retries)**: ${config.retry_attempts}\n\n`;
    
    statusText += `#### Сконфигурированные модели агентов:\n`;
    for (const [agentName, agentConfig] of Object.entries(config.agents)) {
      statusText += `- **${agentName.toUpperCase()}**: \`${agentConfig.model}\` (Reasoning: ${agentConfig.reasoning?.enable ? "Включен" : "Выключен"})\n`;
    }
    
    statusText += `- **Синтезатор (Minimax)**: \`${config.synthesis.model}\` (Reasoning: ${config.synthesis.reasoning?.enable ? "Включен" : "Выключен"})\n`;

    if (config.openrouter_referer) {
      statusText += `- **Заголовок HTTP-Referer**: \`${config.openrouter_referer}\`\n`;
    }
    if (config.openrouter_title) {
      statusText += `- **Заголовок X-Title**: \`${config.openrouter_title}\`\n`;
    }

    if (!config.openrouter_api_key || config.openrouter_api_key.includes("YOUR_")) {
      statusText += `\n⚠️ **Внимание**: API-ключ не настроен. Укажите переменную окружения \`OPENROUTER_API_KEY\` или обновите \`config.json\`.`;
    }

    if (doActivePing) {
      statusText += `\n\n#### 🏓 Результаты активного пинга агентов (таймаут 15с):\n`;
      const agentsToPing = Object.keys(config.agents);
      
      const pingConfig = {
        ...config,
        timeout_ms: 15000, // Короткий таймаут для пинга
        retry_attempts: 0 // Без повторных попыток для скорости
      };

      try {
        const pingResult = await runConsultation({
          question: "Respond with exactly the word PONG and nothing else. This is a system liveness check.",
          role: "general",
          agentsList: agentsToPing,
          skipSynthesis: true,
          config: pingConfig
        });

        for (const res of pingResult.agentResults) {
          const cleanOutput = res.content ? res.content.trim().replace(/[^a-zA-Z]/g, "") : "";
          const isPong = cleanOutput.toUpperCase().includes("PONG");

          if (res.success && isPong) {
            statusText += `- **${res.agentName.toUpperCase()}**: ✅ PONG (${(res.durationMs / 1000).toFixed(2)}с)\n`;
          } else if (res.success) {
            statusText += `- **${res.agentName.toUpperCase()}**: ⚠️ Ответил не PONG (ответ: "${res.content?.slice(0, 30)}") (${(res.durationMs / 1000).toFixed(2)}с)\n`;
          } else {
            if (res.error?.includes("не установлен")) {
              statusText += `- **${res.agentName.toUpperCase()}**: ❌ Пропущен (Не установлен в системе)\n`;
            } else {
              statusText += `- **${res.agentName.toUpperCase()}**: ❌ Ошибка (${res.error || "неизвестная ошибка"})\n`;
            }
          }
        }
      } catch (err: any) {
        statusText += `\n❌ Ошибка при выполнении пинга: ${err.message || String(err)}\n`;
      }
    }

    return {
      content: [{ type: "text", text: statusText.trim() }]
    };
  }

  // 3. Запрос консилиума
  if (name === "ask_consultant") {
    const question = args?.question;
    const role = (args?.role as string) || "general";
    const customRolePrompt = args?.custom_role_prompt as string | undefined;
    
    let targetAgentsList = args?.agents as string[] | undefined;
    let autoSkipSynthesis = args?.request_raw_responses !== false && args?.skip_synthesis !== false;

    if (args?.role !== undefined && (typeof args.role !== "string" || !/^[a-z0-9_]{1,64}$/.test(args.role))) {
      return {
        isError: true,
        content: [{ type: "text", text: "Ошибка: Аргумент 'role' должен быть валидной строкой из строчных латинских букв, цифр и символов подчеркивания длиной до 64 символов." }]
      };
    }

    if (targetAgentsList !== undefined) {
      if (!Array.isArray(targetAgentsList) || targetAgentsList.some(agent => typeof agent !== "string" || !/^[a-zA-Z0-9_\-\.]{1,64}$/.test(agent))) {
        return {
          isError: true,
          content: [{ type: "text", text: "Ошибка: Аргумент 'agents' должен быть массивом валидных имен агентов (строк от 1 до 64 символов)." }]
        };
      }
    }

    if (typeof question !== "string" || question.trim() === "") {
      return {
        isError: true,
        content: [{ type: "text", text: "Ошибка: аргумент 'question' должен быть непустой строкой." }]
      };
    }

    // Защита от Prompt Injection и Resource Exhaustion
    if (question.length > 100000) {
      return {
        isError: true,
        content: [{ type: "text", text: "Ошибка: Аргумент 'question' превышает лимит 100000 символов." }]
      };
    }
    if (customRolePrompt && customRolePrompt.length > 4000) {
      return {
        isError: true,
        content: [{ type: "text", text: "Ошибка: Аргумент 'custom_role_prompt' превышает лимит 4000 символов." }]
      };
    }

    if (!targetAgentsList) {
      if (role === "security_auditor") {
        targetAgentsList = ["codex"];
        autoSkipSynthesis = true;
      } else {
        targetAgentsList = ["codex", "claude", "agy", "mimo", "grok"];
      }
    } else if (targetAgentsList.length === 1) {
      autoSkipSynthesis = true;
    }

    const config = await loadConfig();

    const needsOpenRouter = !autoSkipSynthesis || targetAgentsList.some(agentName => {
      return !LOCAL_AGENTS.includes(agentName);
    });

    if (needsOpenRouter && (!config.openrouter_api_key || config.openrouter_api_key.includes("YOUR_"))) {
      return {
        isError: true,
        content: [{ 
          type: "text", 
          text: "Ошибка: Для выполнения синтеза или запроса к облачным моделям требуется API ключ OpenRouter. Задайте переменную окружения OPENROUTER_API_KEY или укажите её в config.json." 
        }]
      };
    }

    if (config.concurrency) {
      consultSemaphore.updateLimits(
        config.concurrency.maxConcurrency ?? 3,
        config.concurrency.maxQueueSize ?? 20,
        config.concurrency.queueTimeoutMs ?? 180000
      );
    }

    await consultSemaphore.acquire();
    try {
      const result = await runConsultation({
        question,
        role,
        customRolePrompt,
        agentsList: targetAgentsList,
        skipSynthesis: autoSkipSynthesis,
        config
      });

      if (!result.success) {
        return {
          isError: true,
          content: [{ type: "text", text: result.outputMarkdown }]
        };
      }

      return {
        content: [{ type: "text", text: result.outputMarkdown }]
      };
    } finally {
      consultSemaphore.release();
    }
  }

  throw new Error(`Неизвестный инструмент: ${name}`);
});

// ── Функция очистки дочерних процессов и сессионных директорий при выходе ──
function cleanupAllChildren() {
  if (activeChildPids.size > 0) {
    process.stderr.write(`[Agent Consult] Завершение работы. Принудительно завершаем ${activeChildPids.size} дочерних процессов...\n`);
    for (const pid of activeChildPids) {
      try {
        if (process.platform === "win32") {
          spawnSync("C:\\Windows\\System32\\taskkill.exe", ["/pid", pid.toString(), "/f", "/t"]);
        } else if (pid > 0) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch (err: any) {
            if (err.code === "ESRCH") {
              process.kill(pid, "SIGKILL");
            } else {
              throw err;
            }
          }
        }
      } catch (err) {
        // Игнорируем
      }
    }
    activeChildPids.clear();
  }

  if (activeSessionDirs.size > 0) {
    process.stderr.write(`[Agent Consult] Завершение работы. Принудительно очищаем ${activeSessionDirs.size} активных сессионных папок...\n`);
    for (const dir of activeSessionDirs) {
      try {
        const stat = fsSync.lstatSync(dir);
        if (stat.isSymbolicLink()) {
          fsSync.unlinkSync(dir);
        } else {
          fsSync.rmSync(dir, { recursive: true, force: true });
        }
      } catch (err) {
        // Игнорируем
      }
    }
    activeSessionDirs.clear();
  }
}

// Регистрируем обработчики выхода родительского процесса
process.on("exit", cleanupAllChildren);
process.on("SIGINT", () => {
  cleanupAllChildren();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupAllChildren();
  process.exit(0);
});
process.on("SIGHUP", () => {
  cleanupAllChildren();
  process.exit(0);
});

// ── Подключение транспорта и старт сервера ──────────────────────────────
async function main() {
  // Устанавливаем строгий umask для создаваемых файлов и папок (rw------- / rwx------)
  process.umask(0o077);
  await ensureAgentHomeDirs();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[Agent Consult] MCP сервер успешно запущен по транспорту stdio.\n");
}

main().catch((err) => {
  process.stderr.write(`[Agent Consult] Критическая ошибка при запуске: ${err.message}\n`);
  process.exit(1);
});

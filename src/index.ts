import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, loadRolePrompt, ensureAgentHomeDirs } from "./config.js";
import { checkOpenRouterLiveness } from "./openrouter-client.js";
import { runConsultation, activeChildPids } from "./consult-orchestrator.js";
import { spawn } from "child_process";

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
      "This MCP server provides access to the collective mind of 5 agents (Codex, Claude, Anti-Gravity (agy), Gemini, Mimo). " +
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
          "Sends a complex technical or business question to a group of 4 specialized AI agents (Codex, Claude, agy, Mimo) " +
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
                "Defaults to all 4 available agents: ['codex', 'claude', 'agy', 'mimo'].",
            },
            request_raw_responses: {
              type: "boolean",
              default: false,
              description: 
                "CRITICAL: Do NOT set to true unless the user explicitly requested raw, unsynthesized answers. " +
                "By default (false), the server performs advanced synthesis (Self-Realization) to consolidate all opinions, " +
                "resolve conflicts, and return a single, coherent technical report. Setting this to true returns raw data " +
                "from individual agents, bypassing the synthesizer and increasing cognitive load.",
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
          "and prints the current model mappings for all five agents and the synthesizer.",
        inputSchema: {
          type: "object",
          properties: {},
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
    const isAlive = await checkOpenRouterLiveness(config.openrouter_api_key);
    
    let statusText = `### Статус MCP-сервера "Агент Консалт":\n\n`;
    statusText += `- **Связь с OpenRouter**: ${isAlive ? "✅ Доступен" : "❌ Ошибка подключения / неверный API-ключ"}\n`;
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
    let autoSkipSynthesis = !!(args?.request_raw_responses || args?.skip_synthesis);

    if (!targetAgentsList) {
      if (role === "security_auditor") {
        targetAgentsList = ["codex"];
        autoSkipSynthesis = true;
      } else {
        targetAgentsList = ["codex", "claude", "agy", "mimo"];
      }
    } else if (targetAgentsList.length === 1) {
      autoSkipSynthesis = true;
    }

    if (typeof question !== "string" || question.trim() === "") {
      return {
        isError: true,
        content: [{ type: "text", text: "Ошибка: аргумент 'question' должен быть непустой строкой." }]
      };
    }

    const config = await loadConfig();

    const needsOpenRouter = !autoSkipSynthesis || targetAgentsList.some(agentName => {
      const localAgents = ["codex", "claude", "agy", "gemini", "mimo"];
      return !localAgents.includes(agentName);
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
  }

  throw new Error(`Неизвестный инструмент: ${name}`);
});

// ── Функция очистки дочерних процессов при выходе ──────────────────────
function cleanupAllChildren() {
  if (activeChildPids.size > 0) {
    process.stderr.write(`[Agent Consult] Завершение работы. Принудительно завершаем ${activeChildPids.size} дочерних процессов...\n`);
    for (const pid of activeChildPids) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", pid.toString(), "/f", "/t"]);
        } else {
          process.kill(-pid, "SIGKILL");
        }
      } catch (err) {
        // Игнорируем
      }
    }
    activeChildPids.clear();
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
  await ensureAgentHomeDirs();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[Agent Consult] MCP сервер успешно запущен по транспорту stdio.\n");
}

main().catch((err) => {
  process.stderr.write(`[Agent Consult] Критическая ошибка при запуске: ${err.message}\n`);
  process.exit(1);
});

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, loadRolePrompt, ensureAgentHomeDirs } from "./config.js";
import { checkOpenRouterLiveness } from "./openrouter-client.js";
import { runConsultation } from "./consult-orchestrator.js";

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
      "so that the council of agents receives comprehensive information for deep analysis.",
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
          "Sends a complex technical or business question to a group of 5 specialized AI agents (Codex, Claude, agy, Gemini, Mimo) " +
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
                "Never send short one-line queries. Enrich the question with technical details of the project.",
            },
            role: {
              type: "string",
              enum: ["marketer", "programmer", "system_architect", "web_architect", "app_architect", "general"],
              default: "general",
              description: 
                "Specialist profile determining the context and system instructions for the consultation. " +
                "marketer — marketing/USP/target audience; " +
                "programmer — code/refactoring/testing; " +
                "system_architect — servers/networking/DevOps/CI-CD; " +
                "web_architect — UX/UI/Core Web Vitals/technical SEO; " +
                "app_architect — application architecture/microservices/databases; " +
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
                "List of specific agents to query (e.g. ['codex', 'gemini']). " +
                "Defaults to all 5 available agents: ['codex', 'claude', 'agy', 'gemini', 'mimo'].",
            },
            skip_synthesis: {
              type: "boolean",
              default: false,
              description: 
                "If set to true, the server returns only the raw individual agent responses " +
                "without the final Minimax-M3 synthesis phase. Useful for saving tokens and time.",
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

6. **general** (Универсальный консультант):
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
    const skipSynthesis = !!args?.skip_synthesis;
    const targetAgentsList = (args?.agents as string[]) || ["codex", "claude", "agy", "gemini", "mimo"];

    if (typeof question !== "string" || question.trim() === "") {
      return {
        isError: true,
        content: [{ type: "text", text: "Ошибка: аргумент 'question' должен быть непустой строкой." }]
      };
    }

    const config = await loadConfig();

    const needsOpenRouter = !skipSynthesis || targetAgentsList.some(agentName => {
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
      skipSynthesis,
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

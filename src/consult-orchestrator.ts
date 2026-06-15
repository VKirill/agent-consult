import { AppConfig, AgentConfig, loadConfig, loadRolePrompt, WORKSPACE_ROOT, SERVER_ROOT, AGENT_HOMES_ROOT, setupAgentMcpConfig } from "./config.js";
import { queryOpenRouter, AgentResponse } from "./openrouter-client.js";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import os from "os";

export interface ConsultationResult {
  success: boolean;
  outputMarkdown: string;
  agentResults: AgentResponse[];
  synthesisSuccess: boolean;
  synthesisContent?: string;
  synthesisError?: string;
  totalDurationMs: number;
}

function cleanCLIOutput(output: string): string {
  let lines = output.split("\n");
  lines = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith("warning:") || trimmed.toLowerCase().startsWith("warn:")) return false;
    if (trimmed.includes("ExperimentalWarning:") || trimmed.includes("DeprecationWarning:")) return false;
    if (trimmed.startsWith("[Codex]") || trimmed.startsWith("[info]") || trimmed.startsWith("[debug]")) return false;
    if (trimmed.startsWith(">")) return false;
    return true;
  });
  return lines.join("\n").trim();
}

function stripAnsi(str: string): string {
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

async function queryLocalCLI(
  agentName: string,
  model: string,
  systemPrompt: string,
  question: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let binPath = "";
    let args: string[] = [];

    const cleanModel = model.replace(/^(openai|anthropic|google|xiaomi)\//, "");

    const userHome = os.homedir();

    switch (agentName) {
      case "codex":
        binPath = path.join(userHome, ".npm-global", "bin", "codex");
        args = ["exec", "-", "--model", cleanModel];
        break;
      case "claude":
        binPath = path.join(userHome, ".local", "bin", "claude");
        const modelArg = (cleanModel === "sonnet" || cleanModel === "opus" || cleanModel === "haiku") ? cleanModel : "sonnet";
        args = ["-p", "--model", modelArg, "--output-format", "stream-json", "--verbose"];
        break;
      case "agy":
        binPath = path.join(userHome, ".local", "bin", "agy");
        args = ["-p", "-"];
        break;
      case "gemini":
        binPath = path.join(userHome, ".local", "bin", "agy");
        args = ["-p", "-"];
        break;
      case "mimo":
        binPath = path.join(userHome, ".mimocode", "bin", "mimo");
        args = ["run", "--pure"];
        break;
      default:
        return reject(new Error(`Неизвестный локальный агент: ${agentName}`));
    }

    const agentHome = path.join(AGENT_HOMES_ROOT, agentName);

    const cleanEnv = { ...process.env };
    if (agentName === "codex") {
      delete cleanEnv.OPENAI_API_KEY;
      delete cleanEnv.OPENAI_API_BASE;
      delete cleanEnv.OPENAI_ORGANIZATION;
    }

    const isWindows = process.platform === "win32";
    const child = spawn(binPath, args, {
      cwd: WORKSPACE_ROOT,
      detached: !isWindows,
      env: {
        ...cleanEnv,
        HOME: agentHome,
        GEMINI_CLI_TRUST_WORKSPACE: "true",
        GEMINI_CLI_NO_RELAUNCH: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        TERM: "dumb",
        PAGER: "cat"
      }
    });

    let stdout = "";
    let stderr = "";
    let isSettled = false;
    const startTime = Date.now();
    let currentTimeoutMs = timeoutMs;
    let lastLogTime = 0;
    let timer: NodeJS.Timeout;

    const killProcessGroup = (signal: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
      if (child.pid) {
        try {
          if (isWindows) {
            spawn("taskkill", ["/pid", child.pid.toString(), "/f", "/t"]);
          } else {
            process.kill(-child.pid, signal);
          }
        } catch (killErr) {
          // Игнорируем
        }
      }
    };

    const resetOrExtendTimeout = (reason: string) => {
      if (isSettled) return;
      const now = Date.now();
      const elapsed = now - startTime;
      const originalRemaining = currentTimeoutMs - elapsed;

      if (originalRemaining < 45000) {
        const newRemaining = 45000;
        currentTimeoutMs = elapsed + newRemaining;
        const MAX_TIMEOUT = 900000; 
        if (currentTimeoutMs > MAX_TIMEOUT) {
          currentTimeoutMs = MAX_TIMEOUT;
        }
        const updatedRemaining = currentTimeoutMs - elapsed;

        clearTimeout(timer);
        timer = setTimeout(() => {
          if (isSettled) return;
          isSettled = true;
          killProcessGroup("SIGKILL");
          reject(new Error(`Превышен таймаут ожидания ответа от локального CLI ${agentName} (прошло ${Math.round(elapsed / 1000)} сек, лимит составил ${Math.round(currentTimeoutMs / 1000)} сек)`));
        }, updatedRemaining);

        if (now - lastLogTime > 15000) {
          lastLogTime = now;
          process.stderr.write(`[Агент: ${agentName.toUpperCase()}] Обнаружена активность (${reason}). Продлеваем таймаут: осталось ${Math.round(updatedRemaining / 1000)} сек.\n`);
        }
      }
    };

    timer = setTimeout(() => {
      if (isSettled) return;
      isSettled = true;
      killProcessGroup("SIGTERM");
      setTimeout(() => killProcessGroup("SIGKILL"), 3000);
      reject(new Error(`Превышен таймаут ожидания ответа от локального CLI ${agentName} (${timeoutMs} мс)`));
    }, timeoutMs);

    let stdoutBuffer = "";
    let finalResult = "";

    child.stdout.on("data", (chunk: Buffer) => {
      resetOrExtendTimeout("stdout");
      if (agentName === "claude") {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const ev = JSON.parse(trimmed);
            if (ev.type === "tool_use") {
              process.stderr.write(`[Агент: CLAUDE] Вызов инструмента: ${ev.name} (аргументы: ${JSON.stringify(ev.input)})\n`);
            } else if (ev.type === "tool_result") {
              process.stderr.write(`[Агент: CLAUDE] Инструмент ${ev.tool_name || ""} вернул результат.\n`);
            } else if (ev.type === "result") {
              finalResult = ev.result ?? "";
            } else if (ev.type === "error") {
              process.stderr.write(`[Агент: CLAUDE] Ошибка: ${ev.message}\n`);
            }
          } catch (e) {
            // Игнорируем не-JSON строки
          }
        }
      } else {
        stdout += chunk.toString();
      }
    });

    let stderrLineBuffer = "";
    child.stderr.on("data", (chunk: Buffer) => {
      resetOrExtendTimeout("stderr");
      const chunkStr = chunk.toString();
      stderr += chunkStr;
      
      stderrLineBuffer += chunkStr;
      const lines = stderrLineBuffer.split("\n");
      stderrLineBuffer = lines.pop() || "";
      
      for (const line of lines) {
        const cleanLine = stripAnsi(line).trim();
        if (!cleanLine) continue;
        
        if (cleanLine.includes("ExperimentalWarning:") || cleanLine.includes("DeprecationWarning:")) continue;
        if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\-|\/\\]+$/.test(cleanLine)) continue;
        
        process.stderr.write(`[Агент: ${agentName.toUpperCase()}] ${cleanLine}\n`);
      }
    });

    child.on("close", (code) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Локальный CLI ${agentName} завершился с кодом ${code}.\nStderr: ${stderr}`));
      } else {
        const result = agentName === "claude" && finalResult ? finalResult : stdout;
        resolve(cleanCLIOutput(result));
      }
    });

    child.on("error", (err) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      killProcessGroup();
      reject(err);
    });

    const fullPrompt = `${systemPrompt}\n\nВОПРОС:\n${question}`;
    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}

/**
 * Читает и объединяет скиллы из корневой папки skills/ и изолированной папки home/<agentName>/skills/
 * Поддерживает как одиночные файлы, так и скиллы-папки (ищет файлы SKILL.md, README.md и *.md внутри папок).
 */
async function loadAgentSkills(agentName: string): Promise<string> {
  const globalSkillsDir = path.join(SERVER_ROOT, "skills");
  const agentSkillsDir = path.join(AGENT_HOMES_ROOT, agentName, "skills");
  
  const skills: string[] = [];

  const readSkillsFromDir = async (dirPath: string) => {
    try {
      const items = await fs.readdir(dirPath, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dirPath, item.name);
        
        if (item.isFile()) {
          // Читаем одиночные файлы в корне папки skills
          const ext = path.extname(item.name).toLowerCase();
          if (ext === ".md" || ext === ".txt" || ext === ".json") {
            const content = await fs.readFile(fullPath, "utf-8");
            skills.push(`=== НАВЫК (Файл): ${item.name} ===\n${content}`);
          }
        } else if (item.isDirectory()) {
          // Сканируем папку-скилл
          try {
            const subItems = await fs.readdir(fullPath);
            // Ищем SKILL.md или README.md или любые md-файлы
            const skillFiles = subItems.filter(f => {
              const nameLower = f.toLowerCase();
              return nameLower === "skill.md" || nameLower === "readme.md" || f.endsWith(".md");
            });

            for (const skillFile of skillFiles) {
              const skillFilePath = path.join(fullPath, skillFile);
              const content = await fs.readFile(skillFilePath, "utf-8");
              skills.push(`=== НАВЫК (Модуль): ${item.name}/${skillFile} ===\n${content}`);
            }
          } catch (subErr) {
            // Игнорируем ошибки чтения подпапок
          }
        }
      }
    } catch (err: any) {
      // Игнорируем ошибки, если директория не читается
    }
  };

  await readSkillsFromDir(globalSkillsDir);
  await readSkillsFromDir(agentSkillsDir);

  if (skills.length === 0) {
    return "Локальные навыки не загружены (директории пусты).";
  }

  return skills.join("\n\n");
}

/**
 * Опрашивает одного агента с замером времени и обработкой ошибок
 */
export async function runAgent(
  agentName: string,
  agentConfig: AgentConfig,
  role: string,
  rolePrompt: string,
  question: string,
  apiKey: string,
  timeoutMs: number,
  retryAttempts: number,
  referer?: string,
  title?: string
): Promise<AgentResponse> {
  const ISOLATION_INSTRUCTION = 
    "ПРАВИЛА ОКРУЖЕНИЯ И КОНСУЛЬТАЦИИ:\n" +
    "- Ты являешься виртуальным экспертом-консультантом для текущего проекта.\n" +
    "- Тебе доступно чтение файлов проекта и исследование структуры рабочей директории с помощью твоих инструментов для точного анализа кода.\n" +
    "- Ты работаешь в режиме чтения/анализа (read-only консультация). Не пытайся записывать или модифицировать файлы проекта самостоятельно.\n" +
    "- При ответе опирайся как на предоставленный текст вопроса, так и на результаты исследования файлов проекта (если требуется проанализировать код).\n" +
    "- Форматируй свой ответ структурировано на русском языке с использованием Markdown.";

  const startTime = Date.now();
  const agentSkills = await loadAgentSkills(agentName);
  
  const systemPrompt = 
    `${rolePrompt}\n\n` +
    `${ISOLATION_INSTRUCTION}\n\n` +
    `### ДОСТУПНЫЕ НАВЫКИ (SKILLS):\n${agentSkills}\n\n` +
    `${agentConfig.system_prefix || ""}`;

  try {
    process.stderr.write(`[Consult Orchestrator] Запуск агента ${agentName} (модель: ${agentConfig.model})...\n`);
    
    const localAgents = ["codex", "claude", "agy", "gemini", "mimo"];
    let content = "";

    if (localAgents.includes(agentName)) {
      // Динамически настраиваем .claude.json для агента перед запуском под его роль
      await setupAgentMcpConfig(agentName, role);
      
      process.stderr.write(`[Consult Orchestrator] Вызов локального CLI для агента ${agentName}...\n`);
      content = await queryLocalCLI(
        agentName,
        agentConfig.model,
        systemPrompt,
        question,
        timeoutMs
      );
    } else {
      process.stderr.write(`[Consult Orchestrator] Вызов OpenRouter для агента ${agentName}...\n`);
      content = await queryOpenRouter(
        apiKey,
        agentConfig.model,
        systemPrompt,
        question,
        agentConfig,
        timeoutMs,
        retryAttempts,
        referer,
        title
      );
    }
    
    return {
      agentName,
      model: agentConfig.model,
      success: true,
      content,
      durationMs: Date.now() - startTime
    };
  } catch (err: any) {
    process.stderr.write(`[Consult Orchestrator] Агент ${agentName} завершился с ошибкой: ${err.message}\n`);
    return {
      agentName,
      model: agentConfig.model,
      success: false,
      error: err.message || String(err),
      durationMs: Date.now() - startTime
    };
  }
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
  const { question, role, customRolePrompt, agentsList, skipSynthesis, config } = options;
  const apiKey = config.openrouter_api_key;
  const startTime = Date.now();

  // 1. Определение промпта роли
  let rolePrompt = "";
  if (customRolePrompt) {
    rolePrompt = customRolePrompt;
  } else {
    rolePrompt = await loadRolePrompt(role);
  }

  // 2. Параллельный запуск агентов с отслеживанием прогресса в реальном времени
  const activeAgents = new Set(agentsList);
  let completedCount = 0;

  const progressTimer = setInterval(() => {
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stderr.write(`[Consult Orchestrator] Ожидаем ответы от агентов: ${Array.from(activeAgents).map(a => a.toUpperCase()).join(", ")} (прошло ${elapsedSec} сек)\n`);
  }, 10000);

  const agentPromises = agentsList.map(async agentName => {
    const agentConfig = config.agents[agentName];
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
        config.openrouter_title
      );
      
      completedCount++;
      activeAgents.delete(agentName);
      process.stderr.write(`[Consult Orchestrator] [${completedCount}/${agentsList.length}] Агент ${agentName.toUpperCase()} завершил работу за ${(res.durationMs / 1000).toFixed(1)} сек с результатом: ${res.success ? "✅ Успешно" : "❌ Ошибка"}\n`);
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
        durationMs: Date.now() - startTime
      } as AgentResponse;
    }
  });

  const agentResults = await Promise.all(agentPromises);
  clearInterval(progressTimer);
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
  let synthStartTime = Date.now();

  // 3. Синтез (самореализация) через Minimax-M3
  if (!skipSynthesis && successfulResponses.length > 0) {
    let agentsReport = `Исходный вопрос: "${question}"\n\n`;
    agentsReport += `Роль специалиста: "${role}"\n\n`;
    agentsReport += `Ответы специализированных агентов:\n\n`;
    
    for (const res of successfulResponses) {
      agentsReport += `=== ОТВЕТ АГЕНТА: ${res.agentName.toUpperCase()} (Модель: ${res.model}) ===\n`;
      agentsReport += `${res.content}\n\n`;
    }

    try {
      process.stderr.write(`[Consult Orchestrator] Запуск профессионального синтеза через ${config.synthesis.model}...\n`);
      synthesisContent = await queryOpenRouter(
        apiKey,
        config.synthesis.model,
        config.synthesis.system_prefix || "Ты — Синтезатор Агент Консалт. Проведи профессиональную самореализацию и консолидируй ответы.",
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
  const synthesisDurationMs = Date.now() - synthStartTime;

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
    outputMarkdown += `- **Статус**: ${res.success ? "✅ Успешно" : "❌ Ошибка"}\n`;
    outputMarkdown += `- **Время ответа**: ${(res.durationMs / 1000).toFixed(2)} сек\n\n`;
    
    if (res.success && res.content) {
      outputMarkdown += `#### Ответ:\n${res.content}\n\n`;
    } else {
      outputMarkdown += `#### Ошибка:\n\`${res.error}\`\n\n`;
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

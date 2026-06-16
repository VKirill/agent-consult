import { AppConfig, AgentConfig, loadConfig, loadRolePrompt, loadPersonalityPrompt, WORKSPACE_ROOT, SERVER_ROOT, AGENT_HOMES_ROOT, setupAgentMcpConfig, ensureAgentHomeDirs } from "./config.js";
import { queryOpenRouter, AgentResponse } from "./openrouter-client.js";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { spawn } from "child_process";
import os from "os";

export interface CharacterPersonality {
  id: string;
  name: string;
  description: string;
}

export const activeChildPids = new Set<number>();

export const PERSONALITIES: CharacterPersonality[] = [
  {
    id: "meticulous",
    name: "Дотошный перфекционист",
    description: "Концентрируется на крайних случаях (edge cases), типизации, обработке ошибок и качестве кода."
  },
  {
    id: "questioner",
    name: "Постоянно спрашивающий исследователь",
    description: "Задает глубокие вопросы, ставит под сомнение требования, ищет скрытые предпосылки."
  },
  {
    id: "critic",
    name: "Скептичный критик (Адвокат дьявола)",
    description: "Ищет уязвимости, проблемы производительности, риски масштабируемости и слабые места."
  },
  {
    id: "minimalist",
    name: "Прагматичный минималист",
    description: "Сторонник KISS и YAGNI, предлагает самые простые и чистые решения без избыточного кода."
  },
  {
    id: "innovator",
    name: "Оптимистичный инноватор",
    description: "Предлагает современные стандарты 2026 года, новейшие паттерны и оптимизацию DX."
  },
  {
    id: "pragmatist",
    name: "Прагматик-дедлайнер",
    description: "Ориентируется на ROI и time-to-market. Предлагает решения «здесь и сейчас», балансируя между перфекционизмом и избыточными инновациями."
  },
  {
    id: "security_guard",
    name: "Офицер безопасности",
    description: "Анализирует технические решения на предмет векторов атак, утечки секретов, уязвимостей и прав доступа."
  }
];

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
    const lower = trimmed.toLowerCase();
    
    // Фильтруем предупреждения и служебные логи
    if (lower.startsWith("warning:") || lower.startsWith("warn:")) return false;
    if (trimmed.includes("ExperimentalWarning:") || trimmed.includes("DeprecationWarning:")) return false;
    if (trimmed.startsWith("[Codex]") || trimmed.startsWith("[info]") || trimmed.startsWith("[debug]")) return false;
    if (trimmed.startsWith(">")) return false;
    
    // Фильтруем промежуточные логи мыслей Antigravity CLI (agy/gemini)
    if (lower.startsWith("i will ") || 
        lower.startsWith("i am ") || 
        lower.startsWith("i have ") || 
        lower.startsWith("reading ") || 
        lower.startsWith("searching ") || 
        lower.startsWith("analyzing ") || 
        lower.startsWith("inspecting ")) return false;
        
    return true;
  });
  return lines.join("\n").trim();
}

function stripAnsi(str: string): string {
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

async function detectAndReadSessionArtifacts(agentName: string, startTime: number): Promise<string> {
  // Артефакты создаются только для агентов, использующих Antigravity CLI (agy / gemini)
  if (agentName !== "agy" && agentName !== "gemini") {
    return "";
  }

  const brainDir = path.join(AGENT_HOMES_ROOT, agentName, ".gemini", "antigravity-cli", "brain");
  try {
    const stat = await fs.stat(brainDir);
    if (!stat.isDirectory()) return "";
  } catch (e) {
    return ""; // Директория не существует
  }

  try {
    const dirs = await fs.readdir(brainDir);
    let newestDir = "";
    let newestTime = 0;

    for (const dir of dirs) {
      const fullPath = path.join(brainDir, dir);
      try {
        const dirStat = await fs.stat(fullPath);
        if (dirStat.isDirectory() && dirStat.mtimeMs > newestTime) {
          newestTime = dirStat.mtimeMs;
          newestDir = fullPath;
        }
      } catch (e) {
        // Пропускаем ошибки доступа к файлам
      }
    }

    // Проверяем, что папка была изменена во время или после старта сессии (с запасом 5 секунд)
    if (newestDir && newestTime >= startTime - 5000) {
      const files = await fs.readdir(newestDir);
      let artifactContent = "";

      for (const file of files) {
        // Пропускаем скрытые файлы, папку .system_generated и метаданные
        if (file.startsWith(".") || file === ".system_generated" || file.endsWith(".metadata.json")) {
          continue;
        }

        const filePath = path.join(newestDir, file);
        try {
          const fileStat = await fs.stat(filePath);
          if (fileStat.isFile()) {
            const content = await fs.readFile(filePath, "utf-8");
            artifactContent += `\n\n### 📄 Сгенерированный артефакт: ${file}\n\n${content}\n`;
          }
        } catch (e) {
          // Пропускаем ошибки чтения файлов
        }
      }

      return artifactContent;
    }
  } catch (err) {
    process.stderr.write(`[Orchestrator] Ошибка при поиске артефактов сессии: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  return "";
}

async function queryLocalCLI(
  agentName: string,
  agentConfig: AgentConfig,
  systemPrompt: string,
  question: string,
  timeoutMs: number
): Promise<string> {
  const userHome = os.homedir();
  let tempPromptFile = "";

  if (agentName === "grok") {
    const tempDir = os.tmpdir();
    const rand = Math.random().toString(36).substring(7);
    tempPromptFile = path.join(tempDir, `grok_prompt_${rand}.txt`);
    const fullPrompt = `${systemPrompt}\n\nВОПРОС:\n${question}`;
    await fs.writeFile(tempPromptFile, fullPrompt, "utf-8");
  }

  return new Promise((resolve, reject) => {
    let binPath = "";
    let args: string[] = [];
    const model = agentConfig.model;

    const cleanModel = model.replace(/^(openai|anthropic|google|xiaomi|xai)\//, "");
    let defaultBinPath = "";
    let globalBinName = "";

    const cleanupTempFile = async () => {
      if (tempPromptFile) {
        try {
          await fs.unlink(tempPromptFile);
        } catch (e) {
          // Игнорируем
        }
      }
    };

    switch (agentName) {
      case "codex":
        defaultBinPath = path.join(userHome, ".npm-global", "bin", "codex");
        globalBinName = "codex";
        args = ["exec", "-", "--model", cleanModel];
        if (agentConfig.reasoning?.enable) {
          const effort = agentConfig.reasoning.reasoning_effort || "medium";
          args.push("-c", `model_reasoning_effort=${effort}`);
        }
        break;
      case "claude":
        defaultBinPath = path.join(userHome, ".local", "bin", "claude");
        globalBinName = "claude";
        const modelArg = (cleanModel === "sonnet" || cleanModel === "opus" || cleanModel === "haiku") ? cleanModel : "sonnet";
        args = ["-p", "--model", modelArg, "--output-format", "stream-json", "--verbose", "--permission-mode", "auto"];
        break;
      case "agy":
        defaultBinPath = path.join(userHome, ".local", "bin", "agy");
        globalBinName = "agy";
        args = ["-p", "-"];
        break;
      case "gemini":
        defaultBinPath = path.join(userHome, ".local", "bin", "agy");
        globalBinName = "agy";
        args = ["-p", "-"];
        break;
      case "mimo":
        defaultBinPath = path.join(userHome, ".mimocode", "bin", "mimo");
        globalBinName = "mimo";
        args = ["run", "--pure"];
        break;
      case "grok":
        defaultBinPath = path.join(userHome, ".local", "bin", "grok");
        globalBinName = "grok";
        args = [
          "--no-memory",
          "--always-approve",
          "--permission-mode", "auto",
          "--prompt-file", tempPromptFile
        ];
        if (cleanModel && cleanModel !== "grok") {
          args.push("--model", cleanModel);
        }
        break;
      default:
        cleanupTempFile().then(() => {
          reject(new Error(`Неизвестный локальный агент: ${agentName}`));
        });
        return;
    }

    binPath = existsSync(defaultBinPath) ? defaultBinPath : globalBinName;

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

    if (child.pid) {
      activeChildPids.add(child.pid);
    }

    const cleanupPid = () => {
      if (child.pid) {
        activeChildPids.delete(child.pid);
      }
    };

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
          cleanupPid();
          killProcessGroup("SIGKILL");
          cleanupTempFile().then(() => {
            reject(new Error(`Превышен таймаут ожидания ответа от локального CLI ${agentName} (прошло ${Math.round(elapsed / 1000)} сек, лимит составил ${Math.round(currentTimeoutMs / 1000)} сек)`));
          });
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
      cleanupPid();
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
      cleanupPid();
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      cleanupTempFile().then(async () => {
        if (code !== 0) {
          reject(new Error(`Локальный CLI ${agentName} завершился с кодом ${code}.\nStderr: ${stderr}`));
        } else {
          let result = agentName === "claude" && finalResult ? finalResult : stdout;
          result = cleanCLIOutput(result);

          try {
            const artifacts = await detectAndReadSessionArtifacts(agentName, startTime);
            if (artifacts) {
              result += artifacts;
            }
          } catch (artifactErr: any) {
            process.stderr.write(`[Orchestrator] Ошибка парсинга артефактов: ${artifactErr.message}\n`);
          }

          resolve(result);
        }
      });
    });

    child.on("error", (err) => {
      cleanupPid();
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      killProcessGroup();
      cleanupTempFile().then(() => {
        reject(err);
      });
    });

    const fullPrompt = `${systemPrompt}\n\nВОПРОС:\n${question}`;
    if (agentName !== "grok") {
      child.stdin.write(fullPrompt);
      child.stdin.end();
    }
  });
}

/**
 * Возвращает список доступных скиллов (файлов/модулей) с их путями.
 * Контент файлов не загружается, чтобы не перегружать контекст агента.
 * Агент должен самостоятельно прочесть нужные файлы через инструменты чтения файлов при необходимости.
 */
async function loadAgentSkills(agentName: string): Promise<string> {
  const globalSkillsDir = path.join(SERVER_ROOT, "skills");
  const agentSkillsDir = path.join(AGENT_HOMES_ROOT, agentName, "skills");
  
  const skillsList: string[] = [];

  const scanSkillsFromDir = async (dirPath: string, typeLabel: "Глобальный" | "Локальный") => {
    try {
      const items = await fs.readdir(dirPath, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dirPath, item.name);
        
        if (item.isFile()) {
          const ext = path.extname(item.name).toLowerCase();
          if (ext === ".md" || ext === ".txt" || ext === ".json") {
            skillsList.push(`- **${item.name}** (${typeLabel} файл навыка)\n  Путь: ${fullPath}\n  Инструкция: Если тебе нужна информация по этому навыку, прочитай файл по указанному пути с помощью своих инструментов чтения файлов.`);
          }
        } else if (item.isDirectory()) {
          try {
            const subItems = await fs.readdir(fullPath);
            const skillFiles = subItems.filter(f => {
              const nameLower = f.toLowerCase();
              return nameLower === "skill.md" || nameLower === "readme.md" || f.endsWith(".md");
            });

            for (const skillFile of skillFiles) {
              const skillFilePath = path.join(fullPath, skillFile);
              skillsList.push(`- **${item.name}/${skillFile}** (${typeLabel} модуль навыка)\n  Путь: ${skillFilePath}\n  Инструкция: Если тебе нужна информация по этому навыку, прочитай файл по указанному пути с помощью своих инструментов чтения файлов.`);
            }
          } catch (subErr) {
            // Игнорируем
          }
        }
      }
    } catch (err: any) {
      // Игнорируем
    }
  };

  await scanSkillsFromDir(globalSkillsDir, "Глобальный");
  await scanSkillsFromDir(agentSkillsDir, "Локальный");

  if (skillsList.length === 0) {
    return "Доступные файлы навыков не обнаружены (директории пусты).";
  }

  return "Перед началом работы ознакомься со списком доступных файлов навыков (skills). Ты ОБЯЗАН использовать свои инструменты чтения файлов для просмотра содержимого этих файлов, если тебе требуется применить соответствующий навык:\n\n" + skillsList.join("\n\n");
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
  title?: string,
  personality?: CharacterPersonality
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
  
  let systemPrompt = 
    `${rolePrompt}\n\n` +
    `${ISOLATION_INSTRUCTION}\n\n` +
    `### ДОСТУПНЫЕ НАВЫКИ (SKILLS):\n${agentSkills}\n\n` +
    `${agentConfig.system_prefix || ""}`;

  if (personality) {
    const personalityPrompt = await loadPersonalityPrompt(personality.id);
    if (personalityPrompt) {
      systemPrompt += `\n\n### ТВОЙ ИНДИВИДУАЛЬНЫЙ ХАРАКТЕР (ПЕРСОНАЖ):\n${personalityPrompt}`;
    }
  }

  try {
    process.stderr.write(`[Consult Orchestrator] Запуск агента ${agentName} (модель: ${agentConfig.model}, характер: ${personality ? personality.name : "Обычный"})...\n`);
    
    const localAgents = ["codex", "claude", "agy", "gemini", "mimo", "grok"];
    let content = "";

    if (localAgents.includes(agentName)) {
      // Динамически настраиваем .claude.json для агента перед запуском под его роль
      await setupAgentMcpConfig(agentName, role);
      
      process.stderr.write(`[Consult Orchestrator] Вызов локального CLI для агента ${agentName}...\n`);
      content = await queryLocalCLI(
        agentName,
        agentConfig,
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
      durationMs: Date.now() - startTime,
      personality: personality ? personality.name : undefined
    };
  } catch (err: any) {
    process.stderr.write(`[Consult Orchestrator] Агент ${agentName} завершился с ошибкой: ${err.message}\n`);
    return {
      agentName,
      model: agentConfig.model,
      success: false,
      error: err.message || String(err),
      durationMs: Date.now() - startTime,
      personality: personality ? personality.name : undefined
    };
  }
}

export function isLocalAgentAvailable(agentName: string): boolean {
  const userHome = os.homedir();
  let defaultBinPath = "";
  let globalBinName = "";

  switch (agentName) {
    case "codex":
      defaultBinPath = path.join(userHome, ".npm-global", "bin", "codex");
      globalBinName = "codex";
      break;
    case "claude":
      defaultBinPath = path.join(userHome, ".local", "bin", "claude");
      globalBinName = "claude";
      break;
    case "agy":
    case "gemini":
      defaultBinPath = path.join(userHome, ".local", "bin", "agy");
      globalBinName = "agy";
      break;
    case "mimo":
      defaultBinPath = path.join(userHome, ".mimocode", "bin", "mimo");
      globalBinName = "mimo";
      break;
    case "grok":
      defaultBinPath = path.join(userHome, ".local", "bin", "grok");
      globalBinName = "grok";
      break;
    default:
      return false;
  }

  if (existsSync(defaultBinPath)) {
    return true;
  }

  // Проверка в PATH
  const envPath = process.env.PATH || "";
  const pathDirs = envPath.split(path.delimiter);
  const isWindows = process.platform === "win32";
  const extensions = isWindows ? [".exe", ".cmd", ".bat", ""] : [""];

  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const fullPath = path.join(dir, globalBinName + ext);
      try {
        if (existsSync(fullPath)) {
          return true;
        }
      } catch (e) {
        // Игнорируем ошибки доступа
      }
    }
  }

  return false;
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

  // Синхронизируем директории и актуальные сессионные токены агентов перед каждым запуском консилиума
  await ensureAgentHomeDirs();

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

  const localAgents = ["codex", "claude", "agy", "gemini", "mimo", "grok"];

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

    if (localAgents.includes(agentName) && !isLocalAgentAvailable(agentName)) {
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
        personality
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
      agentsReport += `=== ОТВЕТ АГЕНТА: ${res.agentName.toUpperCase()} (Модель: ${res.model}, Характер: ${res.personality || "Обычный"}) ===\n`;
      agentsReport += `${res.content}\n\n`;
    }

    try {
      process.stderr.write(`[Consult Orchestrator] Запуск профессионального синтеза через ${config.synthesis.model}...\n`);
      
      // Динамически загружаем промпт синтезатора из profiles/synthesis.md, если доступен
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
    if (res.personality) {
      outputMarkdown += `- **Характер**: ${res.personality}\n`;
    }
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

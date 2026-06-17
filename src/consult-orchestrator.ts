import { AppConfig, AgentConfig, loadConfig, loadRolePrompt, loadPersonalityPrompt, WORKSPACE_ROOT, SERVER_ROOT, AGENT_HOMES_ROOT, setupAgentMcpConfig, ensureAgentHomeDirs, getAgentHome, LOCAL_AGENTS, syncAgentCredentialsBack, sanitizeLogMessage, resolveGlobalHome } from "./config.js";
import { queryOpenRouter, AgentResponse } from "./openrouter-client.js";
import fs from "fs/promises";
import fsSync, { existsSync } from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import os from "os";
import { randomUUID } from "crypto";

export interface CharacterPersonality {
  id: string;
  name: string;
  description: string;
}

export const activeChildPids = new Set<number>();
export const activeSessionDirs = new Set<string>();

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

export function cleanCLIOutput(output: string): string {
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

export function stripAnsi(str: string): string {
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

async function detectAndReadSessionArtifacts(agentName: string, startTime: number, sessionId?: string): Promise<string> {
  // Артефакты создаются только для агентов, использующих Antigravity CLI (agy / gemini)
  if (agentName !== "agy" && agentName !== "gemini") {
    return "";
  }

  const brainDir = path.join(getAgentHome(agentName, sessionId), ".gemini", "antigravity-cli", "brain");
  try {
    const stat = await fs.lstat(brainDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "";
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
        const dirStat = await fs.lstat(fullPath);
        if (!dirStat.isSymbolicLink() && dirStat.isDirectory() && dirStat.mtimeMs > newestTime) {
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
          const fileStat = await fs.lstat(filePath);
          if (!fileStat.isSymbolicLink() && fileStat.isFile()) {
            // Защита от OOM при чтении бинарных или гигантских файлов (>100KB)
            if (fileStat.size > 100 * 1024) {
              process.stderr.write(`[Orchestrator] Пропущен файл артефакта ${file} из-за превышения лимита размера (size: ${fileStat.size} bytes)\n`);
              continue;
            }
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
  timeoutMs: number,
  sessionId?: string
): Promise<string> {
  const userHome = resolveGlobalHome();
  let tempPromptFile = "";

  const model = agentConfig.model;
  const cleanModel = model.replace(/^(openai|anthropic|google|xiaomi|xai)\//, "");
  if (cleanModel && !/^[a-zA-Z0-9][a-zA-Z0-9_\-\.]{0,63}$/.test(cleanModel)) {
    throw new Error(`Критическая уязвимость: Некорректное имя модели '${cleanModel}'`);
  }

  if (agentName === "grok") {
    const grokHome = getAgentHome("grok", sessionId);
    tempPromptFile = path.join(grokHome, ".grok", `grok_prompt_${randomUUID()}.txt`);
    const dir = path.dirname(tempPromptFile);
    await fs.mkdir(dir, { recursive: true });
    const fullPrompt = `${systemPrompt}\n\nВОПРОС:\n${question}`;
    // Создаем файл с правами 0o600 для защиты от чтения другими пользователями
    await fs.writeFile(tempPromptFile, fullPrompt, { encoding: "utf-8", mode: 0o600 });
  }

  try {
    return await new Promise<string>((resolve, reject) => {
      let binPath = "";
      let args: string[] = [];

      let defaultBinPath = "";
      let globalBinName = "";

      const cleanupTempFileSync = () => {
        if (tempPromptFile) {
          try {
            if (fsSync.existsSync(tempPromptFile)) {
              fsSync.unlinkSync(tempPromptFile);
            }
          } catch (e) {
            // Игнорируем
          }
        }
      };

      try {
        const binInfo = resolveAgentBinInfo(agentName);
        defaultBinPath = binInfo.defaultBinPath;
        globalBinName = binInfo.globalBinName;
      } catch (e) {
        cleanupTempFileSync();
        reject(new Error(`Неизвестный локальный агент: ${agentName}`));
        return;
      }

      switch (agentName) {
        case "codex":
          args = ["exec", "-", "--model", cleanModel];
          if (agentConfig.reasoning?.enable) {
            const effort = agentConfig.reasoning.reasoning_effort || "medium";
            args.push("-c", `model_reasoning_effort=${effort}`);
          }
          break;
        case "claude":
          const modelArg = (cleanModel === "sonnet" || cleanModel === "opus" || cleanModel === "haiku") ? cleanModel : "sonnet";
          args = ["-p", "--model", modelArg, "--output-format", "stream-json", "--verbose", "--permission-mode", "plan"];
          break;
        case "agy":
        case "gemini":
          args = ["-p", "-"];
          break;
        case "mimo":
          args = ["run", "--pure"];
          break;
        case "grok":
          args = [
            "--no-memory",
            "--permission-mode", "plan",
            "--prompt-file", tempPromptFile
          ];
          if (cleanModel && cleanModel !== "grok") {
            args.push("--model", cleanModel);
          }
          break;
      }

      binPath = existsSync(defaultBinPath) ? defaultBinPath : globalBinName;

      const agentHome = getAgentHome(agentName, sessionId);
      const isWindows = process.platform === "win32";
      
      // Очищаем PATH от относительных путей для предотвращения DLL/Binary hijacking
      const rawPath = process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
      const cleanPath = rawPath
        .split(path.delimiter)
        .filter(p => p && path.isAbsolute(p) && !p.split(path.sep).includes("..") && !p.split(path.sep).includes("."))
        .join(path.delimiter);

      // Безопасное отфильтрованное окружение дочернего процесса (PoLP)
      const childEnv: Record<string, string> = {
        HOME: agentHome,
        PATH: cleanPath,
        LANG: process.env.LANG || "en_US.UTF-8",
        TERM: "dumb",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        GEMINI_CLI_TRUST_WORKSPACE: "false",
        GEMINI_CLI_NO_RELAUNCH: "1",
        PAGER: "cat"
      };

      const child = spawn(binPath, args, {
        cwd: WORKSPACE_ROOT,
        detached: !isWindows,
        env: childEnv
      });

      if (child.pid) {
        activeChildPids.add(child.pid);
      }

      const cleanupPid = () => {
        if (child.pid) {
          activeChildPids.delete(child.pid);
        }
      };

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalStdoutBytes = 0;
      let totalStderrBytes = 0;
      let isSettled = false;
      const startTime = Date.now();
      const ABSOLUTE_MAX_TIMEOUT = 300000; // 5 минут жесткий таймаут
      const absoluteDeadline = startTime + ABSOLUTE_MAX_TIMEOUT;
      let currentTimeoutMs = timeoutMs;
      let lastLogTime = 0;
      let timer: NodeJS.Timeout;
      let killEscalationTimer: NodeJS.Timeout | undefined;

      const killProcessGroup = (signal: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
        if (child.pid && child.pid > 0) {
          try {
            if (isWindows) {
              spawnSync("C:\\Windows\\System32\\taskkill.exe", ["/pid", child.pid.toString(), "/f", "/t"]);
            } else {
              try {
                process.kill(-child.pid, signal);
              } catch (err: any) {
                if (err.code === "ESRCH") {
                  process.kill(child.pid, signal);
                } else {
                  throw err;
                }
              }
            }
          } catch (killErr) {
            // Игнорируем
          }
        }
      };

      const clearAllTimers = () => {
        if (timer) clearTimeout(timer);
        if (killEscalationTimer) clearTimeout(killEscalationTimer);
      };

      const resetOrExtendTimeout = (reason: string) => {
        if (isSettled) return;
        const now = Date.now();
        
        if (now > absoluteDeadline) {
          return;
        }

        const elapsed = now - startTime;
        const originalRemaining = currentTimeoutMs - elapsed;

        if (originalRemaining < 45000) {
          const newRemaining = 45000;
          currentTimeoutMs = elapsed + newRemaining;
          
          const remainingToDeadline = absoluteDeadline - now;
          if (currentTimeoutMs - elapsed > remainingToDeadline) {
            currentTimeoutMs = elapsed + remainingToDeadline;
          }

          const updatedRemaining = currentTimeoutMs - elapsed;
          if (updatedRemaining <= 0) return;

          clearAllTimers();
          timer = setTimeout(() => {
            if (isSettled) return;
            isSettled = true;
            cleanupPid();
            killProcessGroup("SIGTERM");
            killEscalationTimer = setTimeout(() => {
              killProcessGroup("SIGKILL");
            }, 3000);
            cleanupTempFileSync();
            reject(new Error(`Превышен абсолютный таймаут ожидания ответа от локального CLI ${agentName} (${ABSOLUTE_MAX_TIMEOUT / 1000} сек)`));
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
        clearAllTimers();
        killProcessGroup("SIGTERM");
        killEscalationTimer = setTimeout(() => {
          killProcessGroup("SIGKILL");
        }, 3000);
        cleanupTempFileSync();
        reject(new Error(`Превышен таймаут ожидания ответа от локального CLI ${agentName} (${timeoutMs} мс)`));
      }, timeoutMs);

      let stdoutBuffer = "";
      let finalResult = "";

      const checkForInteractiveAuth = (chunk: Buffer): boolean => {
        const outputToCheck = chunk.toString();
        if (
          outputToCheck.includes("To sign in, open this URL") ||
          outputToCheck.includes("Confirm this code") ||
          outputToCheck.includes("Waiting for authorization") ||
          outputToCheck.includes("oauth2/device")
        ) {
          if (!isSettled) {
            isSettled = true;
            cleanupPid();
            clearAllTimers();
            killProcessGroup("SIGKILL");
            cleanupTempFileSync();
            reject(new Error(`Локальный CLI ${agentName} не авторизован (требуется интерактивный вход). Опрос прерван.`));
          }
          return true;
        }
        return false;
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (checkForInteractiveAuth(chunk)) return;
        resetOrExtendTimeout("stdout");
        
        totalStdoutBytes += chunk.length;
        if (totalStdoutBytes > 10 * 1024 * 1024) { // 10 MB limit
          cleanupPid();
          if (!isSettled) {
            isSettled = true;
            clearAllTimers();
            killProcessGroup("SIGKILL");
            cleanupTempFileSync();
            reject(new Error(`Превышен лимит вывода (stdout) для локального CLI ${agentName} (10 MB)`));
          }
          return;
        }

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
                process.stderr.write(sanitizeLogMessage(`[Агент: CLAUDE] Вызов инструмента: ${ev.name} (аргументы: ${JSON.stringify(ev.input)})\n`));
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
          stdoutChunks.push(chunk);
        }
      });

      let stderrLineBuffer = "";
      child.stderr.on("data", (chunk: Buffer) => {
        if (checkForInteractiveAuth(chunk)) return;
        resetOrExtendTimeout("stderr");

        totalStderrBytes += chunk.length;
        if (totalStderrBytes > 10 * 1024 * 1024) { // 10 MB limit
          cleanupPid();
          if (!isSettled) {
            isSettled = true;
            clearAllTimers();
            killProcessGroup("SIGKILL");
            cleanupTempFileSync();
            reject(new Error(`Превышен лимит ошибок (stderr) для локального CLI ${agentName} (10 MB)`));
          }
          return;
        }

        stderrChunks.push(chunk);
        
        const chunkStr = chunk.toString();
        stderrLineBuffer += chunkStr;
        const lines = stderrLineBuffer.split("\n");
        stderrLineBuffer = lines.pop() || "";
        
        for (const line of lines) {
          const cleanLine = stripAnsi(line).trim();
          if (!cleanLine) continue;
          
          if (cleanLine.includes("ExperimentalWarning:") || cleanLine.includes("DeprecationWarning:")) continue;
          if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\-|\/\\]+$/.test(cleanLine)) continue;
          
          const lower = cleanLine.toLowerCase();
          if (lower.includes("error") || lower.includes("fail") || lower.includes("except") || lower.includes("fatal") || lower.includes("warn")) {
            process.stderr.write(`[Агент: ${agentName.toUpperCase()} WARN/ERR] ${cleanLine}\n`);
          }
        }
      });

      child.on("close", (code) => {
        cleanupPid();
        if (isSettled) return;
        isSettled = true;
        clearAllTimers();
        
        cleanupTempFileSync();

        // Выводим остаток stderrLineBuffer, если он остался
        if (stderrLineBuffer.trim()) {
          const cleanLine = stripAnsi(stderrLineBuffer).trim();
          if (cleanLine && !cleanLine.includes("ExperimentalWarning:") && !cleanLine.includes("DeprecationWarning:")) {
            process.stderr.write(`[Агент: ${agentName.toUpperCase()}] ${cleanLine}\n`);
          }
        }

        // Обработка Claude stdoutBuffer без newline
        if (agentName === "claude" && stdoutBuffer.trim()) {
          try {
            const ev = JSON.parse(stdoutBuffer.trim());
            if (ev.type === "result") {
              finalResult = ev.result ?? "";
            }
          } catch (e) {
            // ignore
          }
        }

        const finalStderr = Buffer.concat(stderrChunks).toString();

        if (code !== 0) {
          let cleanStderr = finalStderr;
          if (cleanStderr.length > 512) {
            cleanStderr = cleanStderr.slice(0, 512) + "... (truncated)";
          }
          reject(new Error(`Локальный CLI ${agentName} завершился с кодом ${code}.\nStderr: ${cleanStderr}`));
        } else {
          let result = agentName === "claude" && finalResult ? finalResult : Buffer.concat(stdoutChunks).toString();
          result = cleanCLIOutput(result);

          detectAndReadSessionArtifacts(agentName, startTime, sessionId)
            .then((artifacts) => {
              if (artifacts) {
                result += artifacts;
              }
              resolve(result);
            })
            .catch((artifactErr: any) => {
              process.stderr.write(`[Orchestrator] Ошибка парсинга артефактов: ${artifactErr.message}\n`);
              resolve(result);
            });
        }
      });

      child.on("error", (err) => {
        cleanupPid();
        if (isSettled) return;
        isSettled = true;
        clearAllTimers();
        killProcessGroup();
        cleanupTempFileSync();
        reject(err);
      });

      const fullPrompt = `${systemPrompt}\n\nВОПРОС:\n${question}`;
      if (agentName !== "grok" && child.stdin) {
        child.stdin.on("error", (err) => {
          // Игнорируем EPIPE ошибку записи в закрытый stdin
        });
        child.stdin.write(fullPrompt);
        child.stdin.end();
      }
    });
  } finally {
    if (tempPromptFile) {
      try {
        await fs.unlink(tempPromptFile).catch(() => {});
      } catch (e) {
        // ignore
      }
    }
  }
}

/**
 * Возвращает список доступных скиллов (файлов/модулей) с их путями.
 * Контент файлов не загружается, чтобы не перегружать контекст агента.
 * Агент должен самостоятельно прочесть нужные файлы через инструменты чтения файлов при необходимости.
 */
async function loadAgentSkills(agentName: string, sessionId?: string): Promise<string> {
  const globalSkillsDir = path.join(SERVER_ROOT, "skills");
  const agentSkillsDir = path.join(getAgentHome(agentName, sessionId), "skills");
  
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
  personality?: CharacterPersonality,
  sessionId?: string
): Promise<AgentResponse> {
  const ISOLATION_INSTRUCTION = 
    "ПРАВИЛА ОКРУЖЕНИЯ И КОНСУЛЬТАЦИИ:\n" +
    "- Ты являешься виртуальным экспертом-консультантом для текущего проекта.\n" +
    "- Тебе доступно чтение файлов проекта и исследование структуры рабочей директории с помощью твоих инструментов для точного анализа кода.\n" +
    "- Ты работаешь в режиме чтения/анализа (read-only консультация). Не пытайся записывать или модифицировать файлы проекта самостоятельно.\n" +
    "- При ответе опирайся как на предоставленный текст вопроса, так и на результаты исследования файлов проекта (если требуется проанализировать код).\n" +
    "- Форматируй свой ответ структурировано на русском языке с использованием Markdown.";

  const startTime = Date.now();
  const agentSkills = await loadAgentSkills(agentName, sessionId);
  
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
    
    let content = "";

    if (LOCAL_AGENTS.includes(agentName)) {
      // Динамически настраиваем .claude.json для агента перед запуском под его роль
      await setupAgentMcpConfig(agentName, role, sessionId);
      
      process.stderr.write(`[Consult Orchestrator] Вызов локального CLI для агента ${agentName}...\n`);
      try {
        content = await queryLocalCLI(
          agentName,
          agentConfig,
          systemPrompt,
          question,
          timeoutMs,
          sessionId
        );
      } catch (cliErr: any) {
        const errStr = cliErr.message || String(cliErr);
        const isAuthError = errStr.includes("authentication_failed") || 
                            errStr.includes("authenticate") || 
                            errStr.includes("credentials") || 
                            errStr.includes("401") ||
                            errStr.includes("не авторизован") ||
                            errStr.includes("интерактивный");
                            
        if (isAuthError) {
          process.stderr.write(`[Consult Orchestrator] ⚠️ Обнаружена ошибка авторизации для локального агента ${agentName}. Повторно копируем credentials с хоста...\n`);
          try {
            await ensureAgentHomeDirs(sessionId);
            content = await queryLocalCLI(
              agentName,
              agentConfig,
              systemPrompt,
              question,
              timeoutMs,
              sessionId
            );
          } catch (retryErr: any) {
            process.stderr.write(`[Consult Orchestrator] ❌ Повторный запуск локального агента ${agentName} после восстановления credentials завершился сбоем.\n`);
            throw retryErr;
          }
        } else {
          process.stderr.write(`[Consult Orchestrator] ❌ Ошибка при запуске локального агента ${agentName}: ${errStr}\n`);
          throw cliErr;
        }
      }
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

export function resolveAgentBinInfo(agentName: string): { defaultBinPath: string; globalBinName: string } {
  const userHome = resolveGlobalHome();
  switch (agentName) {
    case "codex":
      return {
        defaultBinPath: path.join(userHome, ".npm-global", "bin", "codex"),
        globalBinName: "codex"
      };
    case "claude":
      return {
        defaultBinPath: path.join(userHome, ".local", "bin", "claude"),
        globalBinName: "claude"
      };
    case "agy":
    case "gemini":
      return {
        defaultBinPath: path.join(userHome, ".local", "bin", "agy"),
        globalBinName: "agy"
      };
    case "mimo":
      return {
        defaultBinPath: path.join(userHome, ".mimocode", "bin", "mimo"),
        globalBinName: "mimo"
      };
    case "grok":
      return {
        defaultBinPath: path.join(userHome, ".local", "bin", "grok"),
        globalBinName: "grok"
      };
    default:
      throw new Error(`Неизвестный агент: ${agentName}`);
  }
}

export function isLocalAgentAvailable(agentName: string): boolean {
  let defaultBinPath = "";
  let globalBinName = "";

  try {
    const binInfo = resolveAgentBinInfo(agentName);
    defaultBinPath = binInfo.defaultBinPath;
    globalBinName = binInfo.globalBinName;
  } catch (e) {
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
          sessionId
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
    // Обратная синхронизация отключена из соображений безопасности (defensive design против credential poisoning)
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
  let synthStartTime = Date.now();

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

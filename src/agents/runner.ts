import fs from "fs/promises";
import fsSync, { existsSync } from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import os from "os";
import { randomUUID } from "crypto";

import { AgentConfig, loadConfig } from "../core/config.js";
import { CharacterPersonality, LOCAL_AGENTS } from "../core/constants.js";
import { resolveGlobalHome, WORKSPACE_ROOT, SERVER_ROOT } from "../core/paths.js";
import { getAgentHome, setupAgentMcpConfig, ensureAgentHomeDirs } from "./sandbox.js";
import { sanitizeLogMessage } from "../utils/security.js";
import { cleanCLIOutput, stripAnsi } from "../utils/text.js";
import { validateToolCallPolicy } from "../utils/policy-gate.js";
import { logAuditToolCall } from "../utils/audit-logger.js";
import { loadAgentSkills } from "./skills.js";
import { queryOpenRouter, AgentResponse } from "../openrouter-client.js";
import { loadPersonalityPrompt } from "../core/config.js";
import { cleanAndValidateModel, buildCliArgs, sanitizeEnvPath, buildChildEnv } from "./cli/invocation.js";
import { parseClaudeStreamLine } from "./cli/claude-stream.js";
import { detectsInteractiveAuth, detectToolActivity, parseToolNameFromText } from "./cli/output-filters.js";

export const activeChildPids = new Set<number>();
export const activeSessionDirs = new Set<string>();

let cachedCleanPath: string | null = null;
const cachedBinPaths = new Map<string, string>();

async function detectAndReadSessionArtifacts(agentName: string, startTime: number, sessionId?: string): Promise<string> {
  if (agentName !== "agy" && agentName !== "gemini") {
    return "";
  }

  const brainDir = path.join(getAgentHome(agentName, sessionId), ".gemini", "antigravity-cli", "brain");
  try {
    const stat = await fs.lstat(brainDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "";
  } catch (e) {
    return "";
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
        // Пропускаем ошибки доступа
      }
    }

    if (newestDir && newestTime >= startTime - 5000) {
      const files = await fs.readdir(newestDir);
      let artifactContent = "";

      for (const file of files) {
        if (file.startsWith(".") || file === ".system_generated" || file.endsWith(".metadata.json")) {
          continue;
        }

        const filePath = path.join(newestDir, file);
        try {
          const fileStat = await fs.lstat(filePath);
          if (!fileStat.isSymbolicLink() && fileStat.isFile()) {
            if (fileStat.size > 100 * 1024) {
              process.stderr.write(`[Orchestrator] Пропущен файл артефакта ${file} из-за превышения лимита размера (size: ${fileStat.size} bytes)\n`);
              continue;
            }
            const content = await fs.readFile(filePath, "utf-8");
            artifactContent += `\n\n### 📄 Сгенерированный артефакт: ${file}\n\n${content}\n`;
          }
        } catch (e) {
          // Пропускаем ошибки чтения
        }
      }

      return artifactContent;
    }
  } catch (err) {
    process.stderr.write(`[Orchestrator] Ошибка при поиске артефактов сессии: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  return "";
}

export async function queryLocalCLI(
  agentName: string,
  agentConfig: AgentConfig,
  systemPrompt: string,
  question: string,
  timeoutMs: number,
  sessionId?: string,
  logFilePath?: string,
  role?: string
): Promise<string> {
  const userHome = resolveGlobalHome();
  let tempPromptFile = "";

  const model = agentConfig.model;
  const cleanModel = cleanAndValidateModel(model);

  if (agentName === "grok") {
    const grokHome = getAgentHome("grok", sessionId);
    tempPromptFile = path.join(grokHome, ".grok", `grok_prompt_${randomUUID()}.txt`);
    const dir = path.dirname(tempPromptFile);
    await fs.mkdir(dir, { recursive: true });
    const fullPrompt = `${systemPrompt}\n\nВОПРОС:\n${question}`;
    await fs.writeFile(tempPromptFile, fullPrompt, { encoding: "utf-8", mode: 0o600 });
  }

  const toolCallMap = new Map<string, { startTime: number, toolName: string, arguments: any }>();

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

      args = buildCliArgs(agentName, cleanModel, agentConfig.reasoning, tempPromptFile);

      if (!cachedCleanPath) {
        const rawPath = process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
        cachedCleanPath = sanitizeEnvPath(rawPath);
      }
      const cleanPath = cachedCleanPath;

      const binCacheKey = `${agentName}:${defaultBinPath}:${globalBinName}`;
      if (!cachedBinPaths.has(binCacheKey)) {
        const resolved = existsSync(defaultBinPath) ? defaultBinPath : globalBinName;
        cachedBinPaths.set(binCacheKey, resolved);
      }
      binPath = cachedBinPaths.get(binCacheKey)!;

      const agentHome = getAgentHome(agentName, sessionId);
      const isWindows = process.platform === "win32";

      const childEnv = buildChildEnv(agentHome, cleanPath);

      const child = spawn(binPath, args, {
        cwd: WORKSPACE_ROOT,
        detached: !isWindows,
        env: childEnv
      });

      if (child.pid) {
        activeChildPids.add(child.pid);
        try {
          os.setPriority(child.pid, 10);
        } catch (e) {
          // ignore
        }
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
      const ABSOLUTE_TIMEOUT_MS = Math.max(timeoutMs, 600000);
      const INITIAL_IDLE_TIMEOUT_MS = 120000;
      const ACTIVE_IDLE_TIMEOUT_MS = 90000;

      let absoluteTimer: NodeJS.Timeout | undefined;
      let idleTimer: NodeJS.Timeout | undefined;
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
            // ignore
          }
        }
      };

      const clearAllTimers = () => {
        if (absoluteTimer) clearTimeout(absoluteTimer);
        if (idleTimer) clearTimeout(idleTimer);
        if (killEscalationTimer) clearTimeout(killEscalationTimer);
      };

      const terminateProcess = (reason: string, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
        if (isSettled) return;
        isSettled = true;
        cleanupPid();
        clearAllTimers();
        killProcessGroup(signal);
        if (signal === "SIGTERM") {
          killEscalationTimer = setTimeout(() => {
            killProcessGroup("SIGKILL");
          }, 3000);
        }
        cleanupTempFileSync();
        reject(new Error(reason));
      };

      absoluteTimer = setTimeout(() => {
        terminateProcess(`Превышен абсолютный таймаут ожидания ответа от локального CLI ${agentName} (${ABSOLUTE_TIMEOUT_MS / 1000} сек)`, "SIGTERM");
      }, ABSOLUTE_TIMEOUT_MS);

      const MCP_TOOL_IDLE_TIMEOUT_MS = 150000;
      let currentIdleTimeout = INITIAL_IDLE_TIMEOUT_MS;
      let hasReceivedData = false;
      let lastLogTime = 0;
      let isExecutingTool = false;

      const resetIdleTimer = () => {
        if (isSettled) return;
        if (idleTimer) clearTimeout(idleTimer);

        idleTimer = setTimeout(() => {
          const statusStr = isExecutingTool ? " (активное выполнение MCP-инструмента)" : "";
          terminateProcess(
            `Превышен таймаут неактивности для локального CLI ${agentName}${statusStr}. Агент не выводил новые данные в течение ${currentIdleTimeout / 1000} сек.`,
            "SIGTERM"
          );
        }, currentIdleTimeout);
      };

      resetIdleTimer();

      const onDataReceived = (source: "stdout" | "stderr", textContext?: string) => {
        const now = Date.now();
        const { isToolCall: detectedToolCall, isToolResult: detectedToolResult } = detectToolActivity(textContext);

        if (detectedToolCall) {
          isExecutingTool = true;
          if (agentName !== "claude") {
            const parsedToolName = parseToolNameFromText(textContext);
            logAuditToolCall({
              sessionId: sessionId || "global",
              agentName,
              role: role || "general",
              toolName: parsedToolName,
              arguments: { raw_text: textContext },
              status: "success"
            });
          }
        } else if (detectedToolResult) {
          isExecutingTool = false;
        }

        if (!hasReceivedData) {
          hasReceivedData = true;
        }
        
        currentIdleTimeout = isExecutingTool ? MCP_TOOL_IDLE_TIMEOUT_MS : ACTIVE_IDLE_TIMEOUT_MS;
        resetIdleTimer();

        if (now - lastLogTime > 15000) {
          lastLogTime = now;
          const statusStr = isExecutingTool ? "Выполнение MCP-инструмента" : "Генерация текста";
          process.stderr.write(`[Агент: ${agentName.toUpperCase()}] Активность (${source}, ${statusStr}). Сброс idle-таймера: ${currentIdleTimeout / 1000} сек.\n`);
        }
      };

      let stdoutLineBuffer = "";
      let stdoutBuffer = "";
      let finalResult = "";

      const checkForInteractiveAuth = (chunk: Buffer): boolean => {
        if (detectsInteractiveAuth(chunk.toString())) {
          terminateProcess(`Локальный CLI ${agentName} не авторизован (требуется интерактивный вход). Опрос прерван.`, "SIGKILL");
          return true;
        }
        return false;
      };

      child.stdout.on("data", (chunk: Buffer) => {
        onDataReceived("stdout", chunk.toString());
        if (checkForInteractiveAuth(chunk)) return;
        
        totalStdoutBytes += chunk.length;
        if (totalStdoutBytes > 10 * 1024 * 1024) {
          terminateProcess(`Превышен лимит вывода (stdout) для локального CLI ${agentName} (10 MB)`, "SIGKILL");
          return;
        }

        if (agentName === "claude") {
          stdoutBuffer += chunk.toString();
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() ?? "";
          for (const line of lines) {
            const ev = parseClaudeStreamLine(line);
            if (!ev) continue;

            if (ev.kind === "tool_use") {
              isExecutingTool = true;
              const { toolName, toolInput, toolUseId } = ev;
              const msg = `[Агент: CLAUDE] Вызов инструмента: ${toolName} (аргументы: ${JSON.stringify(toolInput)})\n`;
              process.stderr.write(sanitizeLogMessage(msg));

              // Запускаем асинхронную обработку политики и аудит-лог
              (async () => {
                const validation = await validateToolCallPolicy(role || "general", toolName, toolInput);

                logAuditToolCall({
                  sessionId: sessionId || "global",
                  agentName,
                  role: role || "general",
                  toolName,
                  arguments: validation.sanitizedArguments,
                  status: "pending"
                });

                toolCallMap.set(toolUseId, {
                  startTime: Date.now(),
                  toolName,
                  arguments: validation.sanitizedArguments
                });
              })().catch(() => {});

              if (logFilePath) {
                const timestamp = new Date().toISOString();
                const sanitized = sanitizeLogMessage(`Вызов инструмента: ${toolName} (аргументы: ${JSON.stringify(toolInput)})`);
                fsSync.appendFileSync(logFilePath, `[${timestamp}] [CLAUDE] [TOOL_CALL] ${sanitized}\n`);
              }
            } else if (ev.kind === "tool_result") {
              isExecutingTool = false;
              const { toolName, toolUseId } = ev;
              process.stderr.write(`[Агент: CLAUDE] Инструмент ${toolName} вернул результат.\n`);

              const cachedCall = toolCallMap.get(toolUseId);
              if (cachedCall) {
                const durationMs = Date.now() - cachedCall.startTime;
                logAuditToolCall({
                  sessionId: sessionId || "global",
                  agentName,
                  role: role || "general",
                  toolName: cachedCall.toolName,
                  arguments: cachedCall.arguments,
                  status: "success",
                  durationMs
                });
                toolCallMap.delete(toolUseId);
              }

              if (logFilePath) {
                const timestamp = new Date().toISOString();
                fsSync.appendFileSync(logFilePath, `[${timestamp}] [CLAUDE] [TOOL_RESULT] Инструмент ${toolName} вернул результат.\n`);
              }
            } else if (ev.kind === "result") {
              finalResult = ev.result;
            } else if (ev.kind === "error") {
              process.stderr.write(`[Агент: CLAUDE] Ошибка: ${ev.message}\n`);
              if (logFilePath) {
                const timestamp = new Date().toISOString();
                const sanitized = sanitizeLogMessage(ev.message);
                fsSync.appendFileSync(logFilePath, `[${timestamp}] [CLAUDE] [ERROR] ${sanitized}\n`);
              }
            }
          }
        } else {
          stdoutChunks.push(chunk);
          if (logFilePath) {
            const chunkStr = chunk.toString();
            stdoutLineBuffer += chunkStr;
            const lines = stdoutLineBuffer.split("\n");
            stdoutLineBuffer = lines.pop() || "";
            for (const line of lines) {
              const timestamp = new Date().toISOString();
              const cleanLine = stripAnsi(line).trim();
              if (cleanLine) {
                const sanitized = sanitizeLogMessage(cleanLine);
                fsSync.appendFileSync(logFilePath, `[${timestamp}] [${agentName.toUpperCase()}] [STDOUT] ${sanitized}\n`);
              }
            }
          }
        }
      });

      let stderrLineBuffer = "";
      child.stderr.on("data", (chunk: Buffer) => {
        onDataReceived("stderr", chunk.toString());
        if (checkForInteractiveAuth(chunk)) return;

        totalStderrBytes += chunk.length;
        if (totalStderrBytes > 10 * 1024 * 1024) {
          terminateProcess(`Превышен лимит ошибок (stderr) для локального CLI ${agentName} (10 MB)`, "SIGKILL");
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
          
          if (logFilePath) {
            const timestamp = new Date().toISOString();
            const sanitized = sanitizeLogMessage(cleanLine);
            fsSync.appendFileSync(logFilePath, `[${timestamp}] [${agentName.toUpperCase()}] [STDERR] ${sanitized}\n`);
          }

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

        if (stderrLineBuffer.trim()) {
          const cleanLine = stripAnsi(stderrLineBuffer).trim();
          if (cleanLine && !cleanLine.includes("ExperimentalWarning:") && !cleanLine.includes("DeprecationWarning:")) {
            process.stderr.write(`[Агент: ${agentName.toUpperCase()}] ${cleanLine}\n`);
            if (logFilePath) {
              const timestamp = new Date().toISOString();
              const sanitized = sanitizeLogMessage(cleanLine);
              fsSync.appendFileSync(logFilePath, `[${timestamp}] [${agentName.toUpperCase()}] [STDERR] ${sanitized}\n`);
            }
          }
        }

        if (agentName !== "claude" && stdoutLineBuffer.trim()) {
          if (logFilePath) {
            const timestamp = new Date().toISOString();
            const cleanLine = stripAnsi(stdoutLineBuffer).trim();
            if (cleanLine) {
              const sanitized = sanitizeLogMessage(cleanLine);
              fsSync.appendFileSync(logFilePath, `[${timestamp}] [${agentName.toUpperCase()}] [STDOUT] ${sanitized}\n`);
            }
          }
        }

        if (agentName === "claude" && stdoutBuffer.trim()) {
          const ev = parseClaudeStreamLine(stdoutBuffer);
          if (ev && ev.kind === "result") {
            finalResult = ev.result;
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
          // ignore
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
        // ignore
      }
    }
  }

  return false;
}

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
  sessionId?: string,
  logFilePath?: string
): Promise<AgentResponse> {
  const ISOLATION_INSTRUCTION = 
    "ПРАВИЛА ОКРУЖЕНИЯ И КОНСУЛЬТАЦИИ:\n" +
    "- Ты являешься виртуальным экспертом-консультантом для текущего проекта.\n" +
    "- Тебе доступно чтение файлов проекта и исследование структуры рабочей директории с помощью твоих инструментов для точного анализа кода.\n" +
    "- Ты работаешь в режиме чтения/анализа (read-only консультация). Не пытайся записывать или модифицировать файлы проекта самостоятельно.\n" +
    "- Пиши все свои размышления, найденные ошибки, рекомендации и примеры кода СРАЗУ в свое конечное текстовое сообщение (в текстовый ответ). Не создавай для этого отдельные файлы (например, markdown-отчеты или текстовые файлы) на диске, если тебя об этом не попросили напрямую.\n" +
    "- При ответе опирайся как на предоставленный текст вопроса, так и на результаты исследования файлов проекта (если требуется проанализировать код).\n" +
    "- Форматируй свой ответ структурировано на русском языке с использованием Markdown.";

  const startTime = Date.now();
  const agentSkills = await loadAgentSkills(agentName, sessionId);
  
  const config = await loadConfig();
  const allowedMcp = config.role_mcp_mapping?.[role] || config.role_mcp_mapping?.["general"] || [];
  const mcpInventoryList = allowedMcp.map(s => `- **${s}**`).join("\n");
  const mcpRuntimeInstructions = 
    `### ДОСТУПНЫЕ MCP RUNTIME ИНСТРУМЕНТЫ (Сессия ${sessionId || "global"}):\n` +
    `Тебе доступны следующие МЦП-серверы для выполнения задач:\n${mcpInventoryList}\n\n` +
    `ПРАВИЛА ОБРАБОТКИ ОШИБОК И FALLBACK:\n` +
    `1. Режим работы: Read-Only (только чтение). Не пытайся записывать файлы в рабочую директорию проекта.\n` +
    `2. При использовании gitnexus в мультипроектном окружении ОБЯЗАТЕЛЬНО передавай аргумент repo: "agent-consult" во все вызовы инструментов (например, в impact, context, detect_changes).\n` +
    `3. Если МЦП-инструмент вернул ошибку или завис по таймауту: сделай ОДНУ попытку повторного вызова с уменьшенным диапазоном поиска/строк. В случае повторного сбоя — переходи к локальным файлам (через стандартные инструменты чтения/поиска) и явно укажи в ответе: "⚠️ МЦП-сервер [Имя] недоступен, применен локальный fallback".\n` +
    `4. Не используй общие shell-команды (run_command, bash) для задач поиска по коду, которые могут быть решены специализированными МЦП-серверами (gitnexus, repowise).`;

  let systemPrompt = 
    `${rolePrompt}\n\n` +
    `${ISOLATION_INSTRUCTION}\n\n` +
    `### ДОСТУПНЫЕ НАВЫКИ (SKILLS):\n${agentSkills}\n\n` +
    `${mcpRuntimeInstructions}\n\n` +
    `${agentConfig.system_prefix || ""}`;

  if (personality) {
    const personalityPrompt = await loadPersonalityPrompt(personality.id);
    if (personalityPrompt) {
      systemPrompt += `\n\n### ТВОЙ ИНДИВИДУАЛЬНЫЙ ХАРАКТЕР (ПЕРСОНАЖ):\n${personalityPrompt}`;
    }
  }

  if (logFilePath) {
    const timestamp = new Date().toISOString();
    fsSync.appendFileSync(logFilePath, `[${timestamp}] [SYSTEM] Запуск агента ${agentName.toUpperCase()} (модель: ${agentConfig.model}, характер: ${personality ? personality.name : "Обычный"})\n`);
  }

  try {
    process.stderr.write(`[Consult Orchestrator] Запуск агента ${agentName} (модель: ${agentConfig.model}, характер: ${personality ? personality.name : "Обычный"})...\n`);
    
    let content = "";

    if (LOCAL_AGENTS.includes(agentName)) {
      await setupAgentMcpConfig(agentName, role, sessionId);
      
      process.stderr.write(`[Consult Orchestrator] Вызов локального CLI для агента ${agentName}...\n`);
      try {
        content = await queryLocalCLI(
          agentName,
          agentConfig,
          systemPrompt,
          question,
          timeoutMs,
          sessionId,
          logFilePath,
          role
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
              sessionId,
              logFilePath,
              role
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
    
    const durationMs = Date.now() - startTime;
    if (logFilePath) {
      const timestamp = new Date().toISOString();
      fsSync.appendFileSync(logFilePath, `[${timestamp}] [SYSTEM] Агент ${agentName.toUpperCase()} успешно завершил работу за ${(durationMs / 1000).toFixed(1)} сек.\n`);
    }

    return {
      agentName,
      model: agentConfig.model,
      success: true,
      content,
      durationMs,
      personality: personality ? personality.name : undefined
    };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    process.stderr.write(`[Consult Orchestrator] Агент ${agentName} завершился с ошибкой: ${err.message}\n`);
    if (logFilePath) {
      const timestamp = new Date().toISOString();
      fsSync.appendFileSync(logFilePath, `[${timestamp}] [SYSTEM] Агент ${agentName.toUpperCase()} завершился ошибкой за ${(durationMs / 1000).toFixed(1)} сек: ${err.message || String(err)}\n`);
    }

    return {
      agentName,
      model: agentConfig.model,
      success: false,
      error: err.message || String(err),
      durationMs,
      personality: personality ? personality.name : undefined
    };
  }
}

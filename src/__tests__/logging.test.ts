import { describe, it, expect } from "vitest";
import { sanitizeLogMessage } from "../utils/security.js";
import { resolveGlobalHome } from "../core/paths.js";
import { runConsultation } from "../orchestrator/consultation.js";
import { loadConfig } from "../core/config.js";
import fs from "fs/promises";
import path from "path";

describe("sanitizeLogMessage", () => {
  it("should redact OpenRouter and other API keys", () => {
    const key1 = "sk-or-v1-" + "a".repeat(64);
    const key2 = "sk-abcdef123456abcdef123456";
    expect(sanitizeLogMessage(`my key: ${key1}`)).toBe("my key: [REDACTED_OPENROUTER_KEY]");
    expect(sanitizeLogMessage(`my other key: ${key2}`)).toBe("my other key: [REDACTED_API_KEY]");
  });

  it("should redact Bearer authorization header tokens", () => {
    const log = "Authorization: Bearer sk-or-v1-something";
    expect(sanitizeLogMessage(log)).toBe("Authorization: Bearer [REDACTED_TOKEN]");
  });

  it("should redact passwords and secrets from json-like messages", () => {
    const log = '{"password": "secret_password", "token": "sensitive", "secret": "shh", "other": "public"}';
    const sanitized = sanitizeLogMessage(log);
    expect(sanitized).toContain('"password": "[REDACTED]"');
    expect(sanitized).toContain('"token": "[REDACTED]"');
    expect(sanitized).toContain('"secret": "[REDACTED]"');
    expect(sanitized).toContain('"other": "public"');
  });
});

describe("Consultation Logging Lifecycle", () => {
  it("should create a log directory and write the initial header", async () => {
    const logsDir = path.join(resolveGlobalHome(), ".agent-consult", "logs");
    
    // Подготовим фейковый AppConfig, чтобы runConsultation сразу завершился
    const dummyConfig = {
      openrouter_api_key: "test_key",
      timeout_ms: 1000,
      retry_attempts: 1,
      agents: {},
      synthesis: { model: "test" }
    } as any;

    // Вызываем runConsultation с пустым списком агентов (должно быстро выбросить ошибку или вернуть результат без вызовов)
    const result = await runConsultation({
      question: "Hello Test",
      role: "programmer",
      agentsList: [],
      skipSynthesis: true,
      config: dummyConfig
    });

    expect(result.success).toBe(false); // Ожидаем false так как агентов 0

    // Проверим, что папка логов существует
    const dirExists = await fs.access(logsDir).then(() => true).catch(() => false);
    expect(dirExists).toBe(true);

    // Найдем созданный лог-файл
    const files = await fs.readdir(logsDir);
    const logFiles = files.filter(f => f.startsWith("consultation_") && f.endsWith(".log"));
    expect(logFiles.length).toBeGreaterThan(0);

    // Проверим содержимое последнего лога по времени модификации (mtime)
    const fileStats = await Promise.all(
      logFiles.map(async f => {
        const p = path.join(logsDir, f);
        const stat = await fs.stat(p);
        return { path: p, mtime: stat.mtimeMs };
      })
    );
    fileStats.sort((a, b) => b.mtime - a.mtime);
    const latestLogPath = fileStats[0].path;
    const logContent = await fs.readFile(latestLogPath, "utf-8");

    expect(logContent).toContain("Старт консилиума");
    expect(logContent).toContain("Hello Test");
    expect(logContent).toContain("programmer");
  });
});

import { logAuditToolCall } from "./utils/audit-logger.js";
// @ts-ignore
import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs";
import { resolveGlobalHome } from "./core/paths.js";

async function testAuditLogging() {
  console.log("=== ТЕСТ SQLite АУДИТ-ЛОГГЕРА (consult-audit) ===");

  const globalHome = resolveGlobalHome();
  const dbPath = path.join(globalHome, ".agent-consult", "logs", "audit.db");

  // Запоминаем количество записей до теста
  let initialCount = 0;
  if (fs.existsSync(dbPath)) {
    // @ts-ignore
    const db = new DatabaseSync(dbPath);
    const result: any = db.prepare("SELECT COUNT(*) as cnt FROM tool_calls").get();
    initialCount = result.cnt;
  }

  const testSessionId = `test_session_${Date.now()}`;
  console.log(`Запуск тестовой сессии: ${testSessionId}`);

  // 1. Тестируем запись старта вызова инструмента (с секретами в аргументах)
  logAuditToolCall({
    sessionId: testSessionId,
    agentName: "claude",
    role: "programmer",
    toolName: "gitnexus/impact",
    arguments: {
      target: "ROLE_MCP_MAPPING",
      apiKey: "sk-or-v1-" + "a".repeat(64),
      password: "my_secret_password"
    },
    status: "pending"
  });

  // 2. Тестируем запись успешного выполнения
  logAuditToolCall({
    sessionId: testSessionId,
    agentName: "claude",
    role: "programmer",
    toolName: "gitnexus/impact",
    arguments: {
      target: "ROLE_MCP_MAPPING"
    },
    status: "success",
    durationMs: 120,
    errorMessage: undefined
  });

  // 3. Тестируем запись ошибки
  logAuditToolCall({
    sessionId: testSessionId,
    agentName: "claude",
    role: "programmer",
    toolName: "perplexity/search",
    arguments: {
      query: "latest news"
    },
    status: "failed",
    durationMs: 450,
    errorMessage: "API key sk-somethinglongerthan20chars is invalid or authorization failed"
  });

  // 4. Проверяем записи в базе данных
  if (!fs.existsSync(dbPath)) {
    throw new Error(`База данных аудита не создана по пути: ${dbPath}`);
  }

  // @ts-ignore
  const db = new DatabaseSync(dbPath);
  const rows: any = db.prepare("SELECT * FROM tool_calls WHERE session_id = ? ORDER BY id ASC").all(testSessionId);

  console.log(`Найдено записей для тестовой сессии: ${rows.length}`);
  if (rows.length !== 3) {
    throw new Error(`Ожидалось 3 записи, найдено: ${rows.length}`);
  }

  // Проверка маскирования секретов
  const firstRow = rows[0];
  console.log("Проверка маскирования первой записи...");
  const parsedArgs = JSON.parse(firstRow.arguments);
  
  if (parsedArgs.apiKey !== "[REDACTED_OPENROUTER_KEY]") {
    throw new Error(`API ключ не был замаскирован! Значение: ${parsedArgs.apiKey}`);
  }
  if (parsedArgs.password !== "[REDACTED]") {
    throw new Error(`Пароль не был замаскирован! Значение: ${parsedArgs.password}`);
  }
  console.log("✅ Секреты в аргументах успешно замаскированы шлюзом безопасности.");

  // Проверка маскирования ошибок
  const thirdRow = rows[2];
  console.log("Проверка маскирования ошибок...");
  if (!thirdRow.error_message.includes("[REDACTED_API_KEY]")) {
    throw new Error(`Секреты в сообщении об ошибке не были замаскированы! Значение: ${thirdRow.error_message}`);
  }
  console.log("✅ Секреты в сообщениях об ошибках успешно замаскированы шлюзом безопасности.");

  console.log("\n✅ Все проверки логгера consult-audit и шлюза безопасности пройдены успешно!");
}

testAuditLogging().catch(err => {
  console.error("❌ Тест завершился сбоем:", err);
  process.exit(1);
});

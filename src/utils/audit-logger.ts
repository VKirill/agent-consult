// @ts-ignore
import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs";
import { resolveGlobalHome } from "../core/paths.js";
import { sanitizeLogMessage } from "./security.js";

// @ts-ignore
let dbInstance: DatabaseSync | null = null;

// @ts-ignore
function ensureDatabase(): DatabaseSync {
  if (dbInstance) {
    return dbInstance;
  }

  const globalHome = resolveGlobalHome();
  const logsDir = path.join(globalHome, ".agent-consult", "logs");

  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const dbPath = path.join(logsDir, "audit.db");
  const db = new DatabaseSync(dbPath);

  // Включаем режим WAL и увеличиваем таймаут ожидания для параллельных процессов
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");

  // Создаем таблицу аудита, если она не существует
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      agent_name TEXT,
      role TEXT,
      tool_name TEXT,
      arguments TEXT,
      timestamp TEXT,
      status TEXT,
      duration_ms INTEGER,
      error_message TEXT
    )
  `);

  dbInstance = db;
  return db;
}

export interface ToolCallRecord {
  sessionId: string;
  agentName: string;
  role: string;
  toolName: string;
  arguments: any;
  status: "pending" | "success" | "failed";
  durationMs?: number;
  errorMessage?: string;
}

/**
 * Логирует вызов инструмента в SQLite базу данных аудита.
 */
export function logAuditToolCall(record: ToolCallRecord): void {
  try {
    const db = ensureDatabase();

    const stmt = db.prepare(`
      INSERT INTO tool_calls (session_id, agent_name, role, tool_name, arguments, timestamp, status, duration_ms, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const argsStr = sanitizeLogMessage(JSON.stringify(record.arguments));
    const errorStr = record.errorMessage ? sanitizeLogMessage(record.errorMessage) : null;
    const timestamp = new Date().toISOString();

    stmt.run(
      record.sessionId,
      record.agentName,
      record.role,
      record.toolName,
      argsStr,
      timestamp,
      record.status,
      record.durationMs ?? null,
      errorStr
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[Audit Logger Error] Не удалось записать лог аудита: ${msg}\n`);
  }
}

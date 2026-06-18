import path from "path";
import os from "os";
import fsSync from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Корень самого MCP-сервера
export const SERVER_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Определяет реальный глобальный HOME пользователя, обходя песочницы и sudo-изоляцию
 */
export function resolveGlobalHome(): string {
  if (process.env.AGENT_CONSULT_USER_HOME) {
    return process.env.AGENT_CONSULT_USER_HOME;
  }

  const sudoUser = process.env.SUDO_USER || process.env.USER || process.env.LOGNAME;
  if (process.platform !== "win32" && sudoUser && sudoUser !== "root") {
    const isMac = process.platform === "darwin";
    const baseDir = isMac ? "/Users" : "/home";
    const candidatePath = path.join(baseDir, sudoUser);
    
    try {
      if (fsSync.existsSync(candidatePath)) {
        return candidatePath;
      }
    } catch {
      // ignore
    }
  }

  const currentHome = os.homedir();
  if (currentHome.includes(".agent-consult")) {
    const idx = currentHome.indexOf(".agent-consult");
    return currentHome.substring(0, idx - 1);
  }

  return currentHome;
}

// Скрытая папка в домашней директории пользователя для изолированных HOME-директорий агентов
export const AGENT_HOMES_ROOT = path.join(resolveGlobalHome(), ".agent-consult", "homes");

// Активное рабочее пространство пользователя (текущий проект)
export const WORKSPACE_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

import fs from "fs/promises";
import path from "path";
import { getAgentHome } from "../sandbox.js";

// Чтение артефактов, сгенерированных antigravity-агентами (agy/gemini)
// в их «brain»-директории за время последнего запуска. Вынесено из
// runner.ts как самостоятельная функция.

export async function detectAndReadSessionArtifacts(
  agentName: string,
  startTime: number,
  sessionId?: string
): Promise<string> {
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

import fs from "fs/promises";
import path from "path";
import { SERVER_ROOT } from "../core/paths.js";
import { getAgentHome } from "./sandbox.js";

/**
 * Возвращает список доступных скиллов (файлов/модулей) с их путями.
 * Контент файлов не загружается, чтобы не перегружать контекст агента.
 * Агент должен самостоятельно прочесть нужные файлы через инструменты чтения файлов при необходимости.
 */
export async function loadAgentSkills(agentName: string, sessionId?: string): Promise<string> {
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

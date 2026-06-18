import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

async function runDirectMcpCall() {
  console.log("=== ВЫЗОВ ИНСТРУМЕНТА НАПРЯМУЮ ЧЕРЕЗ MCP-СЕРВЕР (STDIO PROTOCOL) ===");
  
  const serverPath = path.join(PROJECT_ROOT, "dist", "index.js");
  const serverProcess = spawn("node", [serverPath], {
    cwd: PROJECT_ROOT,
    env: process.env // Прокидываем окружение, включая API ключ
  });

  let responseBuffer = "";
  
  // Читаем stderr сервера для отладочных логов
  serverProcess.stderr.on("data", (data) => {
    const logLines = data.toString().split("\n");
    for (const line of logLines) {
      if (line.trim()) {
        console.log(`[Server Stderr] ${line}`);
      }
    }
  });

  // Читаем stdout сервера для JSON-RPC ответов
  const waitForMessage = (): Promise<any> => {
    return new Promise((resolve) => {
      const onData = (data: Buffer) => {
        responseBuffer += data.toString();
        // Сообщения в MCP разделяются переносом строки (\n)
        if (responseBuffer.includes("\n")) {
          const lines = responseBuffer.split("\n");
          // Забираем первую полную строку
          const firstLine = lines.shift() || "";
          responseBuffer = lines.join("\n");
          
          if (firstLine.trim()) {
            try {
              const json = JSON.parse(firstLine);
              serverProcess.stdout.removeListener("data", onData);
              resolve(json);
            } catch (err) {
              // Если строка не распарсилась как JSON, копим дальше
              responseBuffer = firstLine + "\n" + responseBuffer;
            }
          }
        }
      };
      serverProcess.stdout.on("data", onData);
    });
  };

  // Функция для отправки JSON-RPC сообщения на stdin сервера
  const sendMessage = (msg: any) => {
    serverProcess.stdin.write(JSON.stringify(msg) + "\n");
  };

  try {
    // 1. Отправляем запрос initialize
    console.log("\n[Client] Отправка запроса: initialize...");
    sendMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-direct-client", version: "1.0.0" }
      }
    });

    const initResult = await waitForMessage();
    console.log(`[Client] Получен ответ на initialize (ID: ${initResult.id})`);

    // 2. Отправляем уведомление notifications/initialized
    console.log("[Client] Отправка уведомления: initialized...");
    sendMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    });

    // Небольшая пауза
    await new Promise(r => setTimeout(r, 500));

    // 3. Отправляем запрос tools/call для ask_consultant
    console.log("[Client] Отправка запроса: tools/call (ask_consultant)...");
    const questionText = 
      "Скажи, пожалуйста, откуда конкретно ты сейчас читаешь свои скиллы (skills)? " +
      "Виден ли тебе наш тестовый скилл? Назови секретную фразу.";

    sendMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "ask_consultant",
        arguments: {
          question: questionText,
          role: "general",
          skip_synthesis: true // Без самореализации, как просил пользователь
        }
      }
    });

    console.log("[Client] Ожидаем ответ от MCP-сервера (это может занять около 15-30 секунд)...");
    const callResult = await waitForMessage();
    
    console.log("\n=== ОТВЕТ MCP-СЕРВЕРА ===");
    if (callResult.error) {
      console.error("❌ Ошибка JSON-RPC:", callResult.error);
    } else {
      const content = callResult.result?.content?.[0]?.text;
      if (content) {
        console.log(content);
      } else {
        console.log("Ответ пуст или имеет неверный формат:", JSON.stringify(callResult.result));
      }
    }

  } catch (err) {
    console.error("Ошибка во время теста:", err);
  } finally {
    // Останавливаем процесс сервера
    serverProcess.kill();
  }
}

runDirectMcpCall().catch(err => {
  console.error("Ошибка:", err);
});

import path from "path";

// Чистая (без побочек) адаптерная логика запуска локальных CLI-агентов:
// очистка/валидация имени модели, сборка аргументов, очистка PATH и
// построение окружения дочернего процесса. Извлечено из queryLocalCLI
// для тестируемости — ядро spawn/timing/stream остаётся в runner.ts.

const MODEL_PREFIX_RE = /^(openai|anthropic|google|xiaomi|xai)\//;
const SAFE_MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9_\-\.]{0,63}$/;

export function cleanAndValidateModel(model: string): string {
  const cleanModel = model.replace(MODEL_PREFIX_RE, "");
  if (cleanModel && !SAFE_MODEL_RE.test(cleanModel)) {
    throw new Error(`Критическая уязвимость: Некорректное имя модели '${cleanModel}'`);
  }
  return cleanModel;
}

export interface CliReasoning {
  enable?: boolean;
  reasoning_effort?: string;
}

export function buildCliArgs(
  agentName: string,
  cleanModel: string,
  reasoning: CliReasoning | undefined,
  tempPromptFile: string
): string[] {
  switch (agentName) {
    case "codex": {
      const args = ["exec", "-", "--model", cleanModel];
      if (reasoning?.enable) {
        const effort = reasoning.reasoning_effort || "medium";
        args.push("-c", `model_reasoning_effort=${effort}`);
      }
      return args;
    }
    case "claude": {
      const modelArg =
        cleanModel === "sonnet" || cleanModel === "opus" || cleanModel === "haiku"
          ? cleanModel
          : "sonnet";
      return ["-p", "--model", modelArg, "--output-format", "stream-json", "--verbose", "--permission-mode", "plan"];
    }
    case "agy":
    case "gemini":
      return ["-p", "-"];
    case "mimo":
      return ["run", "--pure"];
    case "grok": {
      const args = ["--no-memory", "--permission-mode", "auto", "--prompt-file", tempPromptFile];
      if (cleanModel && cleanModel !== "grok") {
        args.push("--model", cleanModel);
      }
      return args;
    }
    default:
      return [];
  }
}

export function sanitizeEnvPath(rawPath: string): string {
  return rawPath
    .split(path.delimiter)
    .filter(
      (p) =>
        p &&
        path.isAbsolute(p) &&
        !p.split(path.sep).includes("..") &&
        !p.split(path.sep).includes(".")
    )
    .join(path.delimiter);
}

export function buildChildEnv(agentHome: string, cleanPath: string): Record<string, string> {
  return {
    HOME: agentHome,
    PATH: cleanPath,
    LANG: process.env.LANG || "en_US.UTF-8",
    TERM: "dumb",
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    NO_UPDATE_NOTIFIER: "1",
    NODE_NO_WARNINGS: "1",
    npm_config_update_notifier: "false",
    NODE_OPTIONS: "--max-old-space-size=512",
    UV_THREADPOOL_SIZE: "2",
    GEMINI_CLI_TRUST_WORKSPACE: "false",
    GEMINI_CLI_NO_RELAUNCH: "1",
    PAGER: "cat"
  };
}

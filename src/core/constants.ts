export const LOCAL_AGENTS = ["codex", "claude", "agy", "gemini", "mimo", "grok"];

// Единственный источник истины для sandbox_mode Codex CLI.
// Невалидное значение здесь = падение CLI при старте (инцидент с "workspace-read").
export const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type CodexSandboxMode = typeof CODEX_SANDBOX_MODES[number];

// Режим агента-консультанта: только чтение (он не должен менять файлы).
export const CODEX_CONSULT_SANDBOX_MODE: CodexSandboxMode = "read-only";

// Runtime-проверка перед записью конфига / спавном CLI.
export function assertCodexSandboxMode(value: string): asserts value is CodexSandboxMode {
  if (!CODEX_SANDBOX_MODES.includes(value as CodexSandboxMode)) {
    throw new Error(
      `Недопустимый sandbox_mode для Codex: "${value}". Ожидается одно из: ${CODEX_SANDBOX_MODES.join(", ")}.`
    );
  }
}

export interface CharacterPersonality {
  id: string;
  name: string;
  description: string;
}

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
    description: "Предлагает современные стандарты 2026 года, новейшие паттерны и DX."
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

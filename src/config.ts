// Прокси-файл конфигурации для обратной совместимости.
// Вся логика распределена по специализированным модулям: core/, utils/, agents/.

export {
  SERVER_ROOT,
  AGENT_HOMES_ROOT,
  WORKSPACE_ROOT,
  resolveGlobalHome
} from "./core/paths.js";

export {
  LOCAL_AGENTS
} from "./core/constants.js";

export {
  atomicWriteFile,
  linkCredentialSafe
} from "./utils/fs.js";

export {
  sanitizeLogMessage
} from "./utils/security.js";

export {
  getAgentHome,
  setupAgentMcpConfig,
  ensureAgentHomeDirs,
  syncAgentCredentialsBack
} from "./agents/sandbox.js";

export {
  AgentConfig,
  AppConfig,
  invalidateConfigCache,
  loadConfig,
  loadRolePrompt,
  loadPersonalityPrompt
} from "./core/config.js";

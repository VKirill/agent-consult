// Прокси-файл оркестратора для обратной совместимости.
// Вся логика распределена по специализированным модулям в core/, utils/, agents/, orchestrator/.

export {
  CharacterPersonality,
  PERSONALITIES
} from "./core/constants.js";

export {
  ConsultationResult,
  runConsultation
} from "./orchestrator/consultation.js";

export {
  cleanCLIOutput,
  stripAnsi
} from "./utils/text.js";

export {
  activeChildPids,
  activeSessionDirs,
  queryLocalCLI,
  resolveAgentBinInfo,
  isLocalAgentAvailable,
  runAgent
} from "./agents/runner.js";

export {
  loadAgentSkills
} from "./agents/skills.js";

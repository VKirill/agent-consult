# Changelog

All notable changes to the "Agent Consult" project are documented in this file, detailing the rationale behind each technical decision.

## [1.2.0] — 2026-06-16

### Added
*   **Single-Agent High Reasoning Mode for Security**: Added specialized mode for `security_auditor` that runs only the `codex` agent on the `openai/gpt-5.5` model with high reasoning effort (`model_reasoning_effort = "high"` / `-c model_reasoning_effort=high`).
*   **New Role Profiles & Personalities**: Created `security_auditor`, `qa_engineer`, and `data_engineer` profiles, and introduced `pragmatist` and `security_guard` personalities.
*   **Global Agent Skills**: Added `owasp-top10.md`, `tdd-methodology.md`, and `adr-template.md` skills.
*   **Context7 MCP Server Support**: Integrated `context7` MCP server to `programmer`, `web_architect`, `app_architect`, and `general` roles for searching library docs.
*   **Auto-bypass Synthesis for Single Agents**: Implemented `autoSkipSynthesis` logic when a single agent is queried, optimizing execution speed and token cost.
*   **Automated Security Verification**: Created `test-security-auditor.ts` test case verifying single agent high-reasoning execution flow.

### Changed
*   **Skill Loading Optimization**: Switched from loading full skill file contents to injecting a list of paths and instructions, forcing agents to read skills only when needed.
*   **Gemini Agent Disabled by Default**: Removed `gemini` from the default `targetAgentsList` (now Codex, Claude, agy, Mimo) to protect context limits.

---

## [1.1.0] — 2026-06-16

### Added
*   **Dynamic Liveness Probe**: Implemented an activity tracking heartbeat on `stdout`/`stderr` streams of local CLI processes. When any data chunk is printed and less than 45 seconds remain on the countdown, the timeout automatically extends by another 45 seconds (up to a hard limit of 15 minutes).
*   **Process Group Isolation**: Local child CLI processes now run with `{ detached: true }`. In case of a timeout or crash, `killProcessGroup` sends `SIGKILL` to the entire process group (via negative PID on Unix/Linux and `taskkill /pid PID /f /t` on Windows), preventing orphaned zombie processes.
*   **Event-based JSON Streaming for Claude**: Claude CLI executions are now configured with `--output-format stream-json --verbose`. An incremental JSON line parser logs tool invocations and results in real time.
*   **English Schema Descriptions**: Translated all MCP tool registrations, descriptions, title attributes, and server instructions in `src/index.ts` to English to optimize context tokens and improve tool-calling accuracy.
*   **MCP Tool Docs in Profiles**: Added "Available MCP Tools and Usage" sections to all markdown files in [profiles/](profiles/) to instruct child agents on their permissions and tool usage scenarios.
*   **System Documentation (`docs/`)**: Added `docs/architecture.md`, `docs/troubleshooting.md`, and `docs/roles_and_mcp_mapping.md`.

### Changed
*   Increased the default base timeout from 120 to **240 seconds (4 minutes)** in `config.json` for startup stability under load.

---

## [1.0.1] — 2026-06-15

### Added
*   **Sandbox Isolation**: Relocated agent home environments to `${os.homedir()}/.agent-consult/homes/` with `0700` permissions. Auth credentials are cloned with secure `0600` permissions.
*   **Automated Config Deployment**: The server dynamically generates local `.claude.json` and `settings.json` configurations for launched agents, disabling global MCP server inheritance (`inheritUser: false`).

### Removed
*   Excluded the unused `tavily` MCP server from mappings (retained only `perplexity` for the marketer role).

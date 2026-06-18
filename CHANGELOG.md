# Changelog

All notable changes to the "Agent Consult" project are documented in this file, detailing the rationale behind each technical decision.

## [1.3.0] — 2026-06-18

### Added
*   **`TimeoutController` + characterization harness**: The fragile spawn/timer/terminate core of `queryLocalCLI` is now an isolated, unit-tested class (`src/agents/cli/timeout-controller.ts`) owning the 3-timer tree (absolute / idle / kill-escalation), settle state and forced termination. A mock-`spawn` harness locks behaviour across all termination paths (idle/MCP-tool-idle timeout, kill-escalation, interactive-auth kill, 10 MB limit, error event, non-zero exit).
*   **Six `cli/` modules from `queryLocalCLI` decomposition**: `invocation` (argv/model/PATH/env), `claude-stream` (stream-json parser), `output-filters` (auth-detect, tool-activity, stderr noise/error), `process-supervisor` (`killProcessGroup`), `session-artifacts` (agy/gemini brain reader), `timeout-controller`. The 603-line monolith became a thin orchestrator; test count went from 4 to 94.
*   **Auth-aware OpenRouter liveness**: `checkOpenRouterLiveness` now probes `/api/v1/auth/key` (requires a valid key) and returns `{ ok, reason }` (`ok | missing_key | unauthorized | network`) instead of a misleading boolean from the public `/models` endpoint.
*   **Per-agent reasoning depth** — each local CLI gets its native lever: `codex` (`-c model_reasoning_effort=high`), `claude` (`--effort high`, model `opus`; levels `low|medium|high|xhigh|max`), `mimo` (`--variant high`). All driven from each agent's `reasoning` block in `config.json`.
*   **`grok` agent identity**: a dedicated, stable `GROK_IDENTITY_HOME` (`~/.agent-consult/grok-identity`); the agent logs in with its own device session.
*   **Diagnostics & coverage**: `npm run diagnose:*` scripts; unit tests for config-writer, sandbox-mode validation, liveness, CLI invocation, stream parser, output filters, process supervisor and timeout controller.

### Changed
*   **`CLAUDE` → `opus`**, and `CODEX`/`MIMO` reasoning set to `high` in `config.json`.
*   **Unified MCP config writer** (`src/agents/cli/config-writer.ts`): the three duplicated config serializers (codex TOML / grok TOML / claude JSON) now share one `resolveMcpServerEntries` + `serializeMcpServersToml`. `sandbox.ts` shrank 556→426 lines; header filtering happens in a single place.
*   **`sandbox_mode` typed**: moved to a typed constant with `assertCodexSandboxMode` validation before config write.
*   **Ad-hoc `test-*` scripts** moved out of `src/` into `scripts/` (excluded from the production build; reachable via `npm run diagnose:*`).

### Fixed
*   **Codex failed to launch**: an invalid hard-coded `sandbox_mode = "workspace-read"` was written to codex's `config.toml`; corrected to `read-only`.
*   **Agents could not reach authenticated MCP servers** (gitnexus/context7): the config writer stripped the `Authorization` header (name contains "auth"); the filter was removed across all three writers.
*   **Double `config.toml` write**: `ensureAgentHomeDirs` no longer writes a conflicting minimal codex config — `setupCodexConfig` is the sole owner (it previously clobbered the MCP section and sandbox_mode on re-invocation).
*   **`GROK` logged the user out of their host account**: the sandbox shared the host `~/.grok` OAuth token; grok rotates refresh tokens on use, invalidating the host session on every run. The agent now uses its own identity and never touches `~/.grok`.
*   **`MIMO` returned empty answers**: the local `mimocode` CLI was invoked without `--model` (defaulting to the free "mimo-auto" → `403 Illegal access`) and without the subscription key. Now passes the full `--model` and symlinks the `mimocode` subscription `auth.json` into the sandbox.

### Removed
*   **Fallback model chains** (`DEFAULT_FALLBACK_CHAINS`): the council now uses strictly the configured model / CLI subscription, with no cloud substitutions.
*   **`gemini` agent** (`google/gemini-2.5-pro`): fully disabled — removed from config, `LOCAL_AGENTS`, ping/analysis lists and home bootstrap; it no longer appears in status or polls. (`agy`, also on the antigravity CLI but model `gemini-3.5-flash`, is unaffected.)

---

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

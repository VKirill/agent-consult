# Changelog

All notable changes to the "Agent Consult" project are documented in this file, detailing the rationale behind each technical decision.

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

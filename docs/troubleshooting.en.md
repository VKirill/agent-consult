# Troubleshooting & Observability

This document contains instructions for diagnostics, debugging, and monitoring the operation of AI agents in the **Agent Consult** workspace.

---

## 1. Real-Time Logging & Observability

Each spawned local agent redirects its `stderr` to the parent process's console, prefixed with its active role name. For example:
```
[Agent: CLAUDE] Tool call: Read (args: {"path": "prisma/schema.prisma"})
[Agent: CLAUDE] Tool Read returned a result.
[Agent: CODEX] Resolving imports for index.ts...
```

* **Spinner Noise and Node.js Warnings Filter**: An integrated filter in [src/consult-orchestrator.ts](file:///home/ubuntu/mcp_server/agent_counsult/src/consult-orchestrator.ts) automatically strips system warnings (`ExperimentalWarning`, `DeprecationWarning`) and command-line progress bar animations (`⠋⠙⠹`), keeping the logs clean and readable.
* **Event Log for Claude**: Claude CLI runs with JSON streaming (`stream-json`) enabled, allowing the system to accurately intercept and format MCP tool calls with high granularity.

---

## 2. Dynamic Timeout & Liveness Probe

To mitigate agent lock-ups and hangs during heavy reasoning requests, we implement a **dynamic heartbeat** system:
1. **Base Timeout**: Defined in `config.json` (`timeout_ms`, defaults to `240000` — 4 minutes).
2. **Liveness Buffer (45 seconds)**: When stdout/stderr data is received from the agent, the server checks the remaining duration before force-killing. If less than 45 seconds remain, the deadline is pushed forward, granting the process an additional 45 seconds.
3. **Hard Limit (15 minutes)**: The total execution duration of any single agent is capped at 15 minutes (`900000 ms`) to prevent runaway recursive tools.

---

## 3. Resource Cleanup & Child Process Management (Zombie Processes)

Local agents are executed in isolated process groups:
* **Config**: `spawn` is called with the `{ detached: true }` option.
* **Process Killing**: When a timeout triggers or an error occurs, the server calls `killProcessGroup()`, sending a kill signal to the entire process tree (negative PID on Unix/Linux: `process.kill(-child.pid, 'SIGKILL')`).
* **Windows Compatibility**: On Windows environments, a system utility is invoked for tree-termination: `taskkill /pid PID /f /t`.

This prevents background `git`, `npm`, or compiler processes spawned by the sub-agents from leaking and consuming host CPU/RAM resources.

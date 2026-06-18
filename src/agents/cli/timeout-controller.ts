import { killProcessGroup } from "./process-supervisor.js";

// Контроллер таймаутов дочернего CLI: владеет деревом из трёх таймеров
// (абсолютный, idle, эскалация kill), состоянием settled и логикой
// принудительного завершения. Извлечён из queryLocalCLI; побочки
// (снятие pid, удаление temp-файла, reject) делегируются через onTerminate.

export const INITIAL_IDLE_TIMEOUT_MS = 120000;
export const ACTIVE_IDLE_TIMEOUT_MS = 90000;
export const MCP_TOOL_IDLE_TIMEOUT_MS = 150000;
export const ABSOLUTE_TIMEOUT_FLOOR_MS = 600000;
const KILL_ESCALATION_MS = 3000;

export interface TimeoutControllerOptions {
  agentName: string;
  pid: number | undefined;
  isWindows: boolean;
  absoluteTimeoutMs: number;
  /** Вызывается при принудительном завершении: должен снять pid, удалить temp-файл и reject. */
  onTerminate: (reason: string) => void;
}

export class TimeoutController {
  private settled = false;
  private absoluteTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private killEscalationTimer?: NodeJS.Timeout;
  private currentIdleTimeoutMs = INITIAL_IDLE_TIMEOUT_MS;
  private lastExecutingTool = false;

  constructor(private readonly opts: TimeoutControllerOptions) {}

  get isSettled(): boolean {
    return this.settled;
  }

  /** Запускает абсолютный таймер и первичный idle-таймер. */
  start(): void {
    this.absoluteTimer = setTimeout(() => {
      this.terminate(
        `Превышен абсолютный таймаут ожидания ответа от локального CLI ${this.opts.agentName} (${this.opts.absoluteTimeoutMs / 1000} сек)`,
        "SIGTERM"
      );
    }, this.opts.absoluteTimeoutMs);
    this.armIdle();
  }

  /**
   * Отмечает активность процесса: переключает величину idle-таймаута
   * (активное выполнение инструмента — более длинный) и перезапускает его.
   * Возвращает текущий idle (мс) для логирования.
   */
  noteActivity(isExecutingTool: boolean): number {
    this.lastExecutingTool = isExecutingTool;
    this.currentIdleTimeoutMs = isExecutingTool ? MCP_TOOL_IDLE_TIMEOUT_MS : ACTIVE_IDLE_TIMEOUT_MS;
    this.armIdle();
    return this.currentIdleTimeoutMs;
  }

  private armIdle(): void {
    if (this.settled) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const statusStr = this.lastExecutingTool ? " (активное выполнение MCP-инструмента)" : "";
      this.terminate(
        `Превышен таймаут неактивности для локального CLI ${this.opts.agentName}${statusStr}. Агент не выводил новые данные в течение ${this.currentIdleTimeoutMs / 1000} сек.`,
        "SIGTERM"
      );
    }, this.currentIdleTimeoutMs);
  }

  private clearTimers(): void {
    if (this.absoluteTimer) clearTimeout(this.absoluteTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.killEscalationTimer) clearTimeout(this.killEscalationTimer);
  }

  /** Внешнее завершение (нормальный close / error): пометить settled и погасить таймеры. */
  markSettled(): void {
    this.settled = true;
    this.clearTimers();
  }

  /** Принудительное завершение по таймауту/лимиту/auth: kill группы + эскалация на SIGKILL + reject. */
  terminate(reason: string, signal: "SIGTERM" | "SIGKILL"): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    killProcessGroup(this.opts.pid, signal, this.opts.isWindows);
    if (signal === "SIGTERM") {
      this.killEscalationTimer = setTimeout(() => {
        killProcessGroup(this.opts.pid, "SIGKILL", this.opts.isWindows);
      }, KILL_ESCALATION_MS);
    }
    this.opts.onTerminate(reason);
  }
}

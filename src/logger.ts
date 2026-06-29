/**
 * Structured logger with levels. Zero dependencies.
 *
 * Reused (near-verbatim) from consolidation/_extracted_capabilities/simple-logger.
 * The `ILogger` shape is the contract the HTTP layer and every source fetcher
 * accept, so a silent logger can be injected in tests.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface ILogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, error?: unknown): void;
}

export class Logger implements ILogger {
  private level: LogLevel;

  constructor(level: LogLevel = "info") {
    this.level = level;
  }

  private shouldLog(messageLevel: LogLevel): boolean {
    return levels[messageLevel] >= levels[this.level];
  }

  private formatData(data: unknown): string {
    if (data === undefined) return "";
    try {
      return ` ${JSON.stringify(data)}`;
    } catch {
      return " [unserializable]";
    }
  }

  debug(message: string, data?: unknown): void {
    if (this.shouldLog("debug")) console.error(`debug ${message}${this.formatData(data)}`);
  }

  info(message: string, data?: unknown): void {
    if (this.shouldLog("info")) console.error(`info  ${message}${this.formatData(data)}`);
  }

  warn(message: string, data?: unknown): void {
    if (this.shouldLog("warn")) console.error(`warn  ${message}${this.formatData(data)}`);
  }

  error(message: string, error?: unknown): void {
    if (!this.shouldLog("error")) return;
    console.error(`error ${message}`);
    if (error instanceof Error) {
      console.error(`   ${error.message}`);
    } else if (error !== undefined) {
      console.error(`   ${String(error)}`);
    }
  }
}

export function createLogger(level: LogLevel = "info"): Logger {
  return new Logger(level);
}

export function createSilentLogger(): ILogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

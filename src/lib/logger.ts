import type { LogContext, LogLevel } from "@/lib/types";

function write(level: LogLevel, message: string, context: LogContext) {
  const line = JSON.stringify({ level, message, time: new Date().toISOString(), ...context });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (message: string, context: LogContext = {}) => write("info", message, context),
  warn: (message: string, context: LogContext = {}) => write("warn", message, context),
  error: (message: string, context: LogContext = {}) => write("error", message, context),
};

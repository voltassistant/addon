/**
 * Structured Logger
 * JSON-based logging with levels, context, and rotation
 * Compatible with pino/winston patterns
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  level: LogLevel;
  timestamp: string;
  message: string;
  context?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  pid: number;
  hostname: string;
  module?: string;
  requestId?: string;
  userId?: string;
  duration?: number;
}

export interface LoggerConfig {
  /** Minimum log level to output */
  level: LogLevel;
  /** Pretty print in development */
  pretty: boolean;
  /** Include stack traces */
  includeStackTrace: boolean;
  /** Max log entries to keep in memory (for rotation) */
  maxEntries: number;
  /** Output destination */
  destination: 'console' | 'file' | 'both';
  /** Log file path (if destination includes file) */
  filePath?: string;
  /** Redact sensitive fields */
  redactFields: string[];
  /** Add timestamp to each log */
  timestamp: boolean;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const LOG_COLORS: Record<LogLevel, string> = {
  trace: '\x1b[90m', // Gray
  debug: '\x1b[36m', // Cyan
  info: '\x1b[32m', // Green
  warn: '\x1b[33m', // Yellow
  error: '\x1b[31m', // Red
  fatal: '\x1b[35m', // Magenta
};

const RESET = '\x1b[0m';

/**
 * Default configuration
 */
const defaultConfig: LoggerConfig = {
  level: (process.env.LOG_LEVEL as LogLevel) || 'info',
  pretty: process.env.NODE_ENV !== 'production',
  includeStackTrace: process.env.NODE_ENV !== 'production',
  maxEntries: 10000,
  destination: 'console',
  redactFields: ['password', 'token', 'apiKey', 'secret', 'authorization'],
  timestamp: true,
};

/**
 * In-memory log buffer for rotation
 */
const logBuffer: LogEntry[] = [];

/**
 * Structured Logger Class
 */
export class Logger {
  private config: LoggerConfig;
  private module?: string;
  private defaultContext: Record<string, unknown>;
  private static instance: Logger;

  constructor(config: Partial<LoggerConfig> = {}, module?: string) {
    this.config = { ...defaultConfig, ...config };
    this.module = module;
    this.defaultContext = {};
  }

  /**
   * Get singleton instance
   */
  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Create a child logger with a module name
   */
  child(module: string, context?: Record<string, unknown>): Logger {
    const child = new Logger(this.config, module);
    if (context) {
      child.defaultContext = { ...this.defaultContext, ...context };
    }
    return child;
  }

  /**
   * Set default context for all logs
   */
  setContext(context: Record<string, unknown>): void {
    this.defaultContext = { ...this.defaultContext, ...context };
  }

  /**
   * Check if level should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.level];
  }

  /**
   * Redact sensitive fields from context
   */
  private redact(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(obj)) {
      if (this.config.redactFields.some(f => key.toLowerCase().includes(f.toLowerCase()))) {
        result[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = this.redact(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    
    return result;
  }

  /**
   * Create log entry
   */
  private createEntry(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    error?: Error
  ): LogEntry {
    const entry: LogEntry = {
      level,
      timestamp: new Date().toISOString(),
      message,
      pid: process.pid,
      hostname: process.env.HOSTNAME || 'unknown',
    };

    if (this.module) {
      entry.module = this.module;
    }

    if (context || Object.keys(this.defaultContext).length > 0) {
      entry.context = this.redact({ ...this.defaultContext, ...context });
    }

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
      };
      if (this.config.includeStackTrace && error.stack) {
        entry.error.stack = error.stack;
      }
    }

    return entry;
  }

  /**
   * Format entry for pretty printing
   */
  private formatPretty(entry: LogEntry): string {
    const color = LOG_COLORS[entry.level];
    const levelStr = entry.level.toUpperCase().padEnd(5);
    const timestamp = entry.timestamp.split('T')[1].slice(0, 12);
    const module = entry.module ? `[${entry.module}]` : '';
    
    let output = `${color}${timestamp} ${levelStr}${RESET} ${module} ${entry.message}`;
    
    if (entry.context && Object.keys(entry.context).length > 0) {
      output += ` ${JSON.stringify(entry.context)}`;
    }
    
    if (entry.error) {
      output += `\n  ${color}Error: ${entry.error.name}: ${entry.error.message}${RESET}`;
      if (entry.error.stack) {
        output += `\n${entry.error.stack}`;
      }
    }
    
    return output;
  }

  /**
   * Output log entry
   */
  private output(entry: LogEntry): void {
    // Add to buffer
    logBuffer.push(entry);
    if (logBuffer.length > this.config.maxEntries) {
      logBuffer.shift();
    }

    // Format output
    const output = this.config.pretty
      ? this.formatPretty(entry)
      : JSON.stringify(entry);

    // Console output
    if (this.config.destination === 'console' || this.config.destination === 'both') {
      if (LOG_LEVELS[entry.level] >= LOG_LEVELS.error) {
        console.error(output);
      } else if (LOG_LEVELS[entry.level] >= LOG_LEVELS.warn) {
        console.warn(output);
      } else if (LOG_LEVELS[entry.level] >= LOG_LEVELS.debug) {
        console.debug(output);
      } else {
        console.log(output);
      }
    }

    // File output would go here (requires fs in Node.js)
  }

  /**
   * Log methods for each level
   */
  trace(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('trace')) {
      this.output(this.createEntry('trace', message, context));
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      this.output(this.createEntry('debug', message, context));
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      this.output(this.createEntry('info', message, context));
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      this.output(this.createEntry('warn', message, context));
    }
  }

  error(message: string, errorOrContext?: Error | Record<string, unknown>, context?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      const error = errorOrContext instanceof Error ? errorOrContext : undefined;
      const ctx = errorOrContext instanceof Error ? context : errorOrContext;
      this.output(this.createEntry('error', message, ctx, error));
    }
  }

  fatal(message: string, errorOrContext?: Error | Record<string, unknown>, context?: Record<string, unknown>): void {
    if (this.shouldLog('fatal')) {
      const error = errorOrContext instanceof Error ? errorOrContext : undefined;
      const ctx = errorOrContext instanceof Error ? context : errorOrContext;
      this.output(this.createEntry('fatal', message, ctx, error));
    }
  }

  /**
   * Timed operation logging
   */
  time(label: string): () => void {
    const start = performance.now();
    return () => {
      const duration = Math.round(performance.now() - start);
      this.info(`${label} completed`, { duration, unit: 'ms' });
    };
  }

  /**
   * Request logging helper
   */
  request(
    method: string,
    path: string,
    statusCode: number,
    duration: number,
    context?: Record<string, unknown>
  ): void {
    const level: LogLevel = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    const message = `${method} ${path} ${statusCode}`;
    
    if (this.shouldLog(level)) {
      this.output(this.createEntry(level, message, { ...context, statusCode, duration }));
    }
  }

  /**
   * Get log buffer
   */
  static getBuffer(): LogEntry[] {
    return [...logBuffer];
  }

  /**
   * Clear log buffer
   */
  static clearBuffer(): void {
    logBuffer.length = 0;
  }

  /**
   * Filter logs by level
   */
  static filterByLevel(level: LogLevel): LogEntry[] {
    return logBuffer.filter(entry => LOG_LEVELS[entry.level] >= LOG_LEVELS[level]);
  }

  /**
   * Search logs
   */
  static search(query: string): LogEntry[] {
    const lowerQuery = query.toLowerCase();
    return logBuffer.filter(entry =>
      entry.message.toLowerCase().includes(lowerQuery) ||
      JSON.stringify(entry.context || {}).toLowerCase().includes(lowerQuery)
    );
  }
}

// Export singleton and factory
export const logger = Logger.getInstance();

export function createLogger(module: string, context?: Record<string, unknown>): Logger {
  return logger.child(module, context);
}

// Domain-specific loggers
export const modbusLogger = createLogger('modbus');
export const optimizerLogger = createLogger('optimizer');
export const schedulerLogger = createLogger('scheduler');
export const apiLogger = createLogger('api');
export const pvpcLogger = createLogger('pvpc');

/**
 * Structured Logging Utility for RagTime Pipeline
 * 
 * This utility provides consistent JSON-formatted logging with correlation tracking
 * for the entire document processing pipeline.
 */

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  correlationId: string;
  service: string;
  operation: string;
  data: Record<string, any>;
  message: string;
}

export interface LoggerOptions {
  service?: string;
  enableDebug?: boolean;
  correlationIdHeader?: string;
}

export class StructuredLogger {
  private service: string;
  private enableDebug: boolean;
  private correlationIdHeader: string;

  constructor(options: LoggerOptions = {}) {
    this.service = options.service || process.env.SERVICE_NAME || 'unknown';
    this.enableDebug = options.enableDebug || process.env.LOG_LEVEL === 'DEBUG';
    this.correlationIdHeader = options.correlationIdHeader || process.env.CORRELATION_HEADER_NAME || 'X-Correlation-ID';
  }

  /**
   * Get correlation ID from various sources
   */
  private getCorrelationId(): string {
    // Try to get from environment variable (set by Lambda context)
    if (process.env.CORRELATION_ID) {
      return process.env.CORRELATION_ID;
    }

    // Try to get from global context (set by request handler)
    if ((global as any).correlationId) {
      return (global as any).correlationId;
    }

    // Generate a new correlation ID if not found
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').substring(0, 15);
    const randomId = Math.random().toString(36).substring(2, 8);
    return `AUTO-${timestamp}-${randomId}`;
  }

  /**
   * Set correlation ID for the current execution context
   */
  public setCorrelationId(correlationId: string): void {
    process.env.CORRELATION_ID = correlationId;
    (global as any).correlationId = correlationId;
  }

  /**
   * Extract correlation ID from event (API Gateway, Lambda trigger, etc.)
   */
  public extractCorrelationId(event: any): string {
    let correlationId: string | null = null;

    // API Gateway event
    if (event.headers && event.headers[this.correlationIdHeader]) {
      correlationId = event.headers[this.correlationIdHeader];
    }

    // Direct Lambda invocation
    if (event.correlationId) {
      correlationId = event.correlationId;
    }

    // SNS/SQS message attributes
    if (event.Records && event.Records[0] && event.Records[0].messageAttributes) {
      const messageAttributes = event.Records[0].messageAttributes;
      if (messageAttributes[this.correlationIdHeader]) {
        correlationId = messageAttributes[this.correlationIdHeader].stringValue;
      }
    }

    // If no correlation ID found, generate one
    if (!correlationId) {
      const timestamp = new Date().toISOString().replace(/[-:]/g, '').substring(0, 15);
      const randomId = Math.random().toString(36).substring(2, 8);
      correlationId = `GEN-${timestamp}-${randomId}`;
    }

    this.setCorrelationId(correlationId);
    return correlationId;
  }

  private log(level: LogLevel, operation: string, data: Record<string, any>, message: string): void {
    // Skip debug logs if not enabled
    if (level === 'DEBUG' && !this.enableDebug) {
      return;
    }

    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      correlationId: this.getCorrelationId(),
      service: this.service,
      operation,
      data: { ...data }, // Clone to avoid mutations
      message
    };

    const logString = JSON.stringify(logEntry);

    // Use appropriate console method based on log level
    switch (level) {
      case 'ERROR':
        console.error(logString);
        break;
      case 'WARN':
        console.warn(logString);
        break;
      case 'DEBUG':
        console.debug(logString);
        break;
      default:
        console.log(logString);
    }
  }

  public info(operation: string, data: Record<string, any>, message: string): void {
    this.log('INFO', operation, data, message);
  }

  public warn(operation: string, data: Record<string, any>, message: string): void {
    this.log('WARN', operation, data, message);
  }

  public error(operation: string, data: Record<string, any>, message: string): void {
    this.log('ERROR', operation, data, message);
  }

  public debug(operation: string, data: Record<string, any>, message: string): void {
    this.log('DEBUG', operation, data, message);
  }

  /**
   * Log pipeline stage transitions
   */
  public pipelineStage(stage: string, data: Record<string, any>, message: string): void {
    this.info(`PIPELINE_${stage.toUpperCase()}`, data, message);
  }

  /**
   * Log performance metrics
   */
  public performance(operation: string, duration: number, data: Record<string, any> = {}): void {
    this.info('PERFORMANCE', {
      operation,
      duration,
      unit: 'ms',
      ...data
    }, `${operation} completed in ${duration}ms`);
  }

  /**
   * Log errors with structured format
   */
  public logError(operation: string, error: Error, context: Record<string, any> = {}): void {
    this.error(operation, {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: (error as any).code
      },
      context,
      timestamp: new Date().toISOString()
    }, `${operation} failed: ${error.message}`);
  }

  /**
   * Create a child logger with additional context
   */
  public child(additionalContext: Record<string, any>): ChildLogger {
    return new ChildLogger(this, additionalContext);
  }
}

/**
 * Child logger that includes additional context in all log entries
 */
export class ChildLogger {
  constructor(private parent: StructuredLogger, private context: Record<string, any>) {}

  private mergeData(data: Record<string, any>): Record<string, any> {
    return { ...this.context, ...data };
  }

  public info(operation: string, data: Record<string, any>, message: string): void {
    this.parent.info(operation, this.mergeData(data), message);
  }

  public warn(operation: string, data: Record<string, any>, message: string): void {
    this.parent.warn(operation, this.mergeData(data), message);
  }

  public error(operation: string, data: Record<string, any>, message: string): void {
    this.parent.error(operation, this.mergeData(data), message);
  }

  public debug(operation: string, data: Record<string, any>, message: string): void {
    this.parent.debug(operation, this.mergeData(data), message);
  }

  public pipelineStage(stage: string, data: Record<string, any>, message: string): void {
    this.parent.pipelineStage(stage, this.mergeData(data), message);
  }

  public performance(operation: string, duration: number, data: Record<string, any> = {}): void {
    this.parent.performance(operation, duration, this.mergeData(data));
  }

  public logError(operation: string, error: Error, context: Record<string, any> = {}): void {
    this.parent.logError(operation, error, this.mergeData(context));
  }
}

// Default logger instance
export const logger = new StructuredLogger();

/**
 * Initialize logger for a Lambda function
 */
export function initializeLogger(event: any, serviceName?: string): StructuredLogger {
  const loggerInstance = new StructuredLogger({ service: serviceName });
  loggerInstance.extractCorrelationId(event);
  return loggerInstance;
}
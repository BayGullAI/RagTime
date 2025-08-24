/**
 * Centralized error handler service
 * Phase 3: Error handling standardization
 */

import { 
  ErrorHandler, 
  ErrorContext, 
  ApplicationError, 
  ErrorCategory, 
  ErrorSeverity 
} from '../interfaces/error-handler.interface';
import { 
  BaseApplicationError, 
  InfrastructureError, 
  ExternalApiError,
  ValidationError 
} from '../utils/application-error';
import { StructuredLogger } from '../utils/structured-logger';

export class ErrorHandlerService implements ErrorHandler {
  private logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  /**
   * Convert any error to standardized ApplicationError
   */
  handleError(error: Error | ApplicationError, context: ErrorContext): ApplicationError {
    // If already an ApplicationError, enhance context and return
    if (error instanceof BaseApplicationError) {
      const enhancedError = this.enhanceErrorContext(error, context);
      this.logError(enhancedError);
      return enhancedError;
    }

    // Convert standard errors to ApplicationError
    const applicationError = this.convertToApplicationError(error, context);
    this.logError(applicationError);
    return applicationError;
  }

  /**
   * Determine if an error is retryable
   */
  isRetryableError(error: Error | ApplicationError): boolean {
    if (error instanceof BaseApplicationError) {
      return error.retryable;
    }

    // Default retry logic for standard errors
    return this.isInfrastructureError(error);
  }

  /**
   * Determine if error should be logged (skip low-severity validation errors)
   */
  shouldLogError(error: ApplicationError): boolean {
    // Always log high/critical errors
    if (error.severity === ErrorSeverity.HIGH || error.severity === ErrorSeverity.CRITICAL) {
      return true;
    }

    // Skip logging validation errors (they're expected user errors)
    if (error.category === ErrorCategory.VALIDATION && error.severity === ErrorSeverity.LOW) {
      return false;
    }

    return true;
  }

  /**
   * Convert standard Error to ApplicationError
   */
  private convertToApplicationError(error: Error, context: ErrorContext): ApplicationError {
    // Database connection errors
    if (this.isDatabaseError(error)) {
      return new InfrastructureError(
        `Database operation failed: ${error.message}`,
        context,
        error,
        true
      );
    }

    // AWS SDK errors
    if (this.isAwsError(error)) {
      const awsError = error as any;
      const isRetryable = awsError.retryable || awsError.statusCode >= 500;
      return new InfrastructureError(
        `AWS service error: ${error.message}`,
        { ...context, metadata: { ...context.metadata, awsErrorCode: awsError.code } },
        error,
        isRetryable
      );
    }

    // HTTP/Network errors
    if (this.isNetworkError(error)) {
      return new ExternalApiError(
        'HTTP',
        500,
        `Network error: ${error.message}`,
        context,
        error
      );
    }

    // OpenAI API errors
    if (error.message.includes('OpenAI API error')) {
      const statusMatch = error.message.match(/(\d{3})/);
      const statusCode = statusMatch ? parseInt(statusMatch[1]) : 500;
      return new ExternalApiError(
        'OpenAI',
        statusCode,
        error.message,
        context,
        error
      );
    }

    // Validation-like errors (user input problems)
    if (this.isValidationError(error)) {
      return new ValidationError(error.message, context);
    }

    // Generic fallback
    return new InfrastructureError(
      error.message || 'An unexpected error occurred',
      context,
      error,
      false
    );
  }

  /**
   * Enhance existing ApplicationError with additional context
   */
  private enhanceErrorContext(error: BaseApplicationError, context: ErrorContext): ApplicationError {
    const enhancedContext = {
      ...error.context,
      correlationId: context.correlationId || error.context.correlationId,
      userId: context.userId || error.context.userId,
      tenantId: context.tenantId || error.context.tenantId,
      metadata: {
        ...error.context.metadata,
        ...context.metadata
      }
    };

    return new BaseApplicationError(
      error.code,
      error.category,
      error.severity,
      error.message,
      enhancedContext,
      error.httpStatusCode,
      error.retryable,
      error.userMessage,
      error.originalError
    );
  }

  /**
   * Log errors with appropriate severity
   */
  private logError(error: ApplicationError): void {
    if (!this.shouldLogError(error)) {
      return;
    }

    const logContext = {
      errorCode: error.code,
      category: error.category,
      severity: error.severity,
      httpStatusCode: error.httpStatusCode,
      retryable: error.retryable,
      correlationId: error.context.correlationId,
      userId: error.context.userId,
      tenantId: error.context.tenantId,
      operation: error.context.operation,
      ...error.context.metadata
    };

    if (error.severity === ErrorSeverity.CRITICAL) {
      this.logger.logError(`CRITICAL_ERROR_${error.code}`, new Error(error.message), logContext);
    } else if (error.severity === ErrorSeverity.HIGH) {
      this.logger.logError(`ERROR_${error.code}`, new Error(error.message), logContext);
    } else {
      this.logger.warn(`WARNING_${error.code}`, logContext, error.message);
    }
  }

  // Error type detection helpers
  private isDatabaseError(error: Error): boolean {
    return error.message.includes('database') || 
           error.message.includes('connection') ||
           error.message.includes('PostgreSQL') ||
           (error as any).code?.startsWith('28'); // PostgreSQL connection errors
  }

  private isAwsError(error: Error): boolean {
    return (error as any).name?.includes('AWS') || 
           (error as any).code?.includes('AWS') ||
           error.message.includes('AWS');
  }

  private isNetworkError(error: Error): boolean {
    return error.message.includes('ENOTFOUND') ||
           error.message.includes('ECONNREFUSED') ||
           error.message.includes('timeout') ||
           error.message.includes('network');
  }

  private isInfrastructureError(error: Error): boolean {
    return this.isDatabaseError(error) || 
           this.isAwsError(error) || 
           this.isNetworkError(error);
  }

  private isValidationError(error: Error): boolean {
    return error.message.includes('required') ||
           error.message.includes('invalid') ||
           error.message.includes('must be') ||
           error.message.includes('too large') ||
           error.message.includes('too small') ||
           error.message.includes('missing');
  }
}
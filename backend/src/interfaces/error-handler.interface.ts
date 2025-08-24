/**
 * Standardized error handling interfaces for RagTime application
 * Phase 3: Error handling standardization
 */

export enum ErrorCategory {
  VALIDATION = 'VALIDATION',
  BUSINESS_LOGIC = 'BUSINESS_LOGIC', 
  INFRASTRUCTURE = 'INFRASTRUCTURE',
  EXTERNAL_API = 'EXTERNAL_API',
  AUTHENTICATION = 'AUTHENTICATION',
  AUTHORIZATION = 'AUTHORIZATION',
  RATE_LIMIT = 'RATE_LIMIT',
  NOT_FOUND = 'NOT_FOUND'
}

export enum ErrorSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM', 
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL'
}

export interface ErrorContext {
  correlationId?: string;
  userId?: string;
  tenantId?: string;
  operation: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface ApplicationError {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly severity: ErrorSeverity;
  readonly message: string;
  readonly context: ErrorContext;
  readonly httpStatusCode: number;
  readonly retryable: boolean;
  readonly userMessage?: string;
  readonly originalError?: Error;
}

export interface ErrorHandler {
  handleError(error: Error | ApplicationError, context: ErrorContext): ApplicationError;
  isRetryableError(error: Error | ApplicationError): boolean;
  shouldLogError(error: ApplicationError): boolean;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    category: ErrorCategory;
    retryable: boolean;
    context?: {
      correlationId?: string;
      timestamp: string;
      operation: string;
    };
  };
  details?: any;
  timestamp: string;
}
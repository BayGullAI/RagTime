/**
 * Application error classes for standardized error handling
 * Phase 3: Error handling standardization
 */

import { ErrorCategory, ErrorSeverity, ErrorContext, ApplicationError } from '../interfaces/error-handler.interface';

export class BaseApplicationError extends Error implements ApplicationError {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly severity: ErrorSeverity;
  readonly context: ErrorContext;
  readonly httpStatusCode: number;
  readonly retryable: boolean;
  readonly userMessage?: string;
  readonly originalError?: Error;

  constructor(
    code: string,
    category: ErrorCategory,
    severity: ErrorSeverity,
    message: string,
    context: ErrorContext,
    httpStatusCode: number,
    retryable: boolean = false,
    userMessage?: string,
    originalError?: Error
  ) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
    this.category = category;
    this.severity = severity;
    this.context = context;
    this.httpStatusCode = httpStatusCode;
    this.retryable = retryable;
    this.userMessage = userMessage;
    this.originalError = originalError;

    // Maintain proper stack trace for debugging
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): Record<string, any> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      severity: this.severity,
      message: this.message,
      context: this.context,
      httpStatusCode: this.httpStatusCode,
      retryable: this.retryable,
      userMessage: this.userMessage,
      stack: this.stack
    };
  }
}

// Validation errors (400 Bad Request)
export class ValidationError extends BaseApplicationError {
  constructor(message: string, context: ErrorContext, details?: Record<string, any>) {
    super(
      'VALIDATION_FAILED',
      ErrorCategory.VALIDATION,
      ErrorSeverity.LOW,
      message,
      { ...context, metadata: { ...context.metadata, validationDetails: details } },
      400,
      false,
      'Please check your input and try again'
    );
    this.name = 'ValidationError';
  }
}

// Business logic errors (422 Unprocessable Entity)
export class BusinessLogicError extends BaseApplicationError {
  constructor(code: string, message: string, context: ErrorContext, userMessage?: string) {
    super(
      code,
      ErrorCategory.BUSINESS_LOGIC,
      ErrorSeverity.MEDIUM,
      message,
      context,
      422,
      false,
      userMessage || 'Unable to complete the requested operation'
    );
    this.name = 'BusinessLogicError';
  }
}

// Infrastructure errors (500 Internal Server Error, usually retryable)
export class InfrastructureError extends BaseApplicationError {
  constructor(message: string, context: ErrorContext, originalError?: Error, retryable: boolean = true) {
    super(
      'INFRASTRUCTURE_ERROR',
      ErrorCategory.INFRASTRUCTURE,
      ErrorSeverity.HIGH,
      message,
      context,
      500,
      retryable,
      'A temporary system error occurred. Please try again later',
      originalError
    );
    this.name = 'InfrastructureError';
  }
}

// External API errors (502 Bad Gateway, retryable for 5xx, not for 4xx)
export class ExternalApiError extends BaseApplicationError {
  constructor(
    service: string, 
    statusCode: number, 
    message: string, 
    context: ErrorContext, 
    originalError?: Error
  ) {
    const isRetryable = statusCode >= 500;
    const httpStatusCode = statusCode >= 400 && statusCode < 500 ? 400 : 502;
    
    super(
      `EXTERNAL_API_ERROR_${service.toUpperCase()}`,
      ErrorCategory.EXTERNAL_API,
      isRetryable ? ErrorSeverity.MEDIUM : ErrorSeverity.HIGH,
      message,
      { ...context, metadata: { ...context.metadata, service, externalStatusCode: statusCode } },
      httpStatusCode,
      isRetryable,
      isRetryable 
        ? 'External service temporarily unavailable. Please try again later'
        : 'External service request failed. Please check your request',
      originalError
    );
    this.name = 'ExternalApiError';
  }
}

// Authentication errors (401 Unauthorized)
export class AuthenticationError extends BaseApplicationError {
  constructor(message: string, context: ErrorContext) {
    super(
      'AUTHENTICATION_FAILED',
      ErrorCategory.AUTHENTICATION,
      ErrorSeverity.MEDIUM,
      message,
      context,
      401,
      false,
      'Authentication failed. Please check your credentials'
    );
    this.name = 'AuthenticationError';
  }
}

// Authorization errors (403 Forbidden)
export class AuthorizationError extends BaseApplicationError {
  constructor(message: string, context: ErrorContext, resource?: string) {
    super(
      'AUTHORIZATION_FAILED',
      ErrorCategory.AUTHORIZATION,
      ErrorSeverity.MEDIUM,
      message,
      { ...context, metadata: { ...context.metadata, resource } },
      403,
      false,
      'Access denied. You do not have permission to perform this action'
    );
    this.name = 'AuthorizationError';
  }
}

// Not found errors (404 Not Found)
export class NotFoundError extends BaseApplicationError {
  constructor(resource: string, identifier: string, context: ErrorContext) {
    super(
      'RESOURCE_NOT_FOUND',
      ErrorCategory.NOT_FOUND,
      ErrorSeverity.LOW,
      `${resource} with identifier '${identifier}' was not found`,
      { ...context, metadata: { ...context.metadata, resource, identifier } },
      404,
      false,
      `The requested ${resource.toLowerCase()} could not be found`
    );
    this.name = 'NotFoundError';
  }
}

// Rate limiting errors (429 Too Many Requests)
export class RateLimitError extends BaseApplicationError {
  constructor(context: ErrorContext, retryAfter?: number) {
    super(
      'RATE_LIMIT_EXCEEDED',
      ErrorCategory.RATE_LIMIT,
      ErrorSeverity.LOW,
      'Rate limit exceeded',
      { ...context, metadata: { ...context.metadata, retryAfter } },
      429,
      true,
      `Too many requests. Please try again ${retryAfter ? `after ${retryAfter} seconds` : 'later'}`
    );
    this.name = 'RateLimitError';
  }
}
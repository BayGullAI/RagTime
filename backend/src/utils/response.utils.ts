import { APIGatewayProxyResult } from 'aws-lambda';
import { ApplicationError, ErrorResponse } from '../interfaces/error-handler.interface';

/**
 * Create a standardized API Gateway response with CORS headers
 */
export function createResponse(
  statusCode: number,
  body: any,
  additionalHeaders: Record<string, string> = {}
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      ...additionalHeaders
    },
    body: JSON.stringify(body)
  };
}

/**
 * Create an error response with consistent format
 * @deprecated Use createApplicationErrorResponse for better error handling
 */
export function createErrorResponse(
  statusCode: number,
  error: string,
  message?: string,
  details?: any
): APIGatewayProxyResult {
  return createResponse(statusCode, {
    error,
    message,
    details,
    timestamp: new Date().toISOString()
  });
}

/**
 * Create standardized error response from ApplicationError
 * Phase 3: Standardized error handling
 */
export function createApplicationErrorResponse(
  applicationError: ApplicationError,
  includeDebugInfo: boolean = false
): APIGatewayProxyResult {
  const errorResponse: ErrorResponse = {
    error: {
      code: applicationError.code,
      message: applicationError.userMessage || applicationError.message,
      category: applicationError.category,
      retryable: applicationError.retryable,
      context: {
        correlationId: applicationError.context.correlationId,
        timestamp: applicationError.context.timestamp,
        operation: applicationError.context.operation
      }
    },
    timestamp: new Date().toISOString()
  };

  // Include debug information in development/staging
  if (includeDebugInfo) {
    errorResponse.details = {
      originalMessage: applicationError.message,
      severity: applicationError.severity,
      stack: applicationError.stack,
      metadata: applicationError.context.metadata
    };
  }

  // Add retry-after header for rate limit errors
  const headers: Record<string, string> = {};
  if (applicationError.httpStatusCode === 429 && applicationError.context.metadata?.retryAfter) {
    headers['Retry-After'] = String(applicationError.context.metadata.retryAfter);
  }

  return createResponse(applicationError.httpStatusCode, errorResponse, headers);
}
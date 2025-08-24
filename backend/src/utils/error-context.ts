/**
 * Utility functions for creating error contexts
 * Phase 3: Error handling standardization
 */

import { ErrorContext } from '../interfaces/error-handler.interface';

export function createErrorContext(
  operation: string,
  correlationId?: string,
  userId?: string,
  tenantId?: string,
  metadata?: Record<string, any>
): ErrorContext {
  return {
    correlationId,
    userId,
    tenantId,
    operation,
    timestamp: new Date().toISOString(),
    metadata: metadata || {}
  };
}

export function enhanceErrorContext(
  baseContext: ErrorContext,
  additionalMetadata: Record<string, any>
): ErrorContext {
  return {
    ...baseContext,
    metadata: {
      ...baseContext.metadata,
      ...additionalMetadata
    }
  };
}

/**
 * Extract error context from Lambda event
 */
export function createErrorContextFromEvent(
  event: any,
  operation: string,
  correlationId?: string
): ErrorContext {
  return createErrorContext(
    operation,
    correlationId,
    event.requestContext?.authorizer?.userId,
    event.pathParameters?.tenantId || event.queryStringParameters?.tenant_id,
    {
      httpMethod: event.httpMethod,
      path: event.path,
      userAgent: event.headers?.['User-Agent'] || event.headers?.['user-agent'],
      sourceIp: event.requestContext?.identity?.sourceIp
    }
  );
}
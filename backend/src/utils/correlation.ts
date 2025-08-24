/**
 * Simplified Correlation ID Utilities for RagTime Pipeline
 * 
 * Provides essential correlation ID functionality for document processing traceability.
 * Simplified from 222 lines to <50 lines, removing unused functions and global state.
 */

export interface CorrelationContext {
  correlationId: string;
  documentId?: string;
  fileName?: string;
  sourceUrl?: string;
  pipelineStage: string;
}

/**
 * Generate a new correlation ID
 */
export function generateCorrelationId(prefix: string = 'PROC'): string {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14);
  const randomId = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}-${timestamp}-${randomId}`;
}

/**
 * Create headers with correlation ID for HTTP requests
 */
export function createCorrelationHeaders(correlationId: string): Record<string, string> {
  return {
    'X-Correlation-ID': correlationId,
    'X-Request-ID': correlationId // Alternative header name
  };
}

/**
 * Extract correlation ID from various event types
 */
export function extractCorrelationIdFromEvent(event: any): string | null {
  // API Gateway event
  if (event.headers) {
    const correlationId = 
      event.headers['X-Correlation-ID'] ||
      event.headers['x-correlation-id'] ||
      event.headers['X-Request-ID'] ||
      event.headers['x-request-id'];
    
    if (correlationId) {
      return correlationId;
    }
  }

  // Direct Lambda invocation
  if (event.correlationId) {
    return event.correlationId;
  }

  // SNS message
  if (event.Records && event.Records[0] && event.Records[0].Sns) {
    const messageAttributes = event.Records[0].Sns.MessageAttributes;
    if (messageAttributes && messageAttributes['X-Correlation-ID']) {
      return messageAttributes['X-Correlation-ID'].Value;
    }
  }

  // SQS message
  if (event.Records && event.Records[0] && event.Records[0].messageAttributes) {
    const messageAttributes = event.Records[0].messageAttributes;
    if (messageAttributes['X-Correlation-ID']) {
      return messageAttributes['X-Correlation-ID'].stringValue;
    }
  }

  // DynamoDB trigger with correlation_id field
  if (event.Records && event.Records[0] && event.Records[0].dynamodb) {
    const newImage = event.Records[0].dynamodb.NewImage;
    if (newImage && newImage.correlation_id) {
      return newImage.correlation_id.S;
    }
  }

  return null;
}
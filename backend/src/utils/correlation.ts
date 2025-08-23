/**
 * Correlation ID Utilities for RagTime Pipeline
 * 
 * This utility manages correlation IDs throughout the document processing pipeline
 * to enable complete traceability of documents from upload through vector storage.
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
 * Generate a canary-specific correlation ID
 */
export function generateCanaryCorrelationId(): string {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14);
  const randomId = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `CANARY-${timestamp}-${randomId}`;
}

/**
 * Parse correlation ID to extract metadata
 */
export function parseCorrelationId(correlationId: string): {
  prefix: string;
  timestamp?: string;
  randomId?: string;
  isCanary: boolean;
  isGenerated: boolean;
} {
  const parts = correlationId.split('-');
  const prefix = parts[0];
  const isCanary = prefix === 'CANARY';
  const isGenerated = prefix === 'GEN' || prefix === 'AUTO';

  return {
    prefix,
    timestamp: parts[1] || undefined,
    randomId: parts[2] || undefined,
    isCanary,
    isGenerated
  };
}

/**
 * Create correlation context for pipeline tracking
 */
export function createCorrelationContext(
  correlationId: string,
  pipelineStage: string,
  options: Partial<CorrelationContext> = {}
): CorrelationContext {
  return {
    correlationId,
    pipelineStage,
    ...options
  };
}

/**
 * Add correlation ID to DynamoDB item
 */
export function addCorrelationToDynamoItem(
  item: Record<string, any>,
  correlationId: string,
  additionalFields: Record<string, any> = {}
): Record<string, any> {
  return {
    ...item,
    correlation_id: correlationId,
    correlation_timestamp: new Date().toISOString(),
    ...additionalFields
  };
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

/**
 * Create correlation metadata for Lambda invocation
 */
export function createLambdaInvocationPayload(
  payload: any,
  correlationId: string,
  pipelineStage: string
): any {
  return {
    ...payload,
    correlationId,
    pipelineStage,
    correlationTimestamp: new Date().toISOString()
  };
}

/**
 * Validate correlation ID format
 */
export function isValidCorrelationId(correlationId: string): boolean {
  if (!correlationId || typeof correlationId !== 'string') {
    return false;
  }

  // Check for basic format: PREFIX-TIMESTAMP-RANDOM
  const parts = correlationId.split('-');
  if (parts.length < 2) {
    return false;
  }

  const prefix = parts[0];
  const validPrefixes = ['CANARY', 'PROC', 'GEN', 'AUTO', 'TEST'];
  
  return validPrefixes.includes(prefix);
}

/**
 * Get correlation summary for reporting
 */
export function getCorrelationSummary(correlationId: string): {
  id: string;
  type: 'canary' | 'process' | 'generated' | 'test' | 'unknown';
  timestamp?: Date;
  age?: number; // milliseconds since creation
} {
  const parsed = parseCorrelationId(correlationId);
  
  let type: 'canary' | 'process' | 'generated' | 'test' | 'unknown' = 'unknown';
  if (parsed.isCanary) type = 'canary';
  else if (parsed.isGenerated) type = 'generated';
  else if (parsed.prefix === 'PROC') type = 'process';
  else if (parsed.prefix === 'TEST') type = 'test';

  let timestamp: Date | undefined;
  let age: number | undefined;

  if (parsed.timestamp) {
    // Parse timestamp: YYYYMMDDHHMMSS
    const year = parseInt(parsed.timestamp.substring(0, 4));
    const month = parseInt(parsed.timestamp.substring(4, 6)) - 1; // 0-indexed
    const day = parseInt(parsed.timestamp.substring(6, 8));
    const hour = parseInt(parsed.timestamp.substring(8, 10));
    const minute = parseInt(parsed.timestamp.substring(10, 12));
    const second = parseInt(parsed.timestamp.substring(12, 14));

    timestamp = new Date(year, month, day, hour, minute, second);
    age = Date.now() - timestamp.getTime();
  }

  return {
    id: correlationId,
    type,
    timestamp,
    age
  };
}
import { APIGatewayProxyResult } from 'aws-lambda';

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
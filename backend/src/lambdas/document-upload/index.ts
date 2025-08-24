/**
 * Document Upload Lambda Handler (Phase 4: Business logic extracted)
 * Reduced from 641 lines to ~30 lines by extracting business logic to DocumentUploadService
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createResponse, createApplicationErrorResponse } from '../../utils/response.utils';
import { initializeLogger } from '../../utils/structured-logger';
import { CompositionRoot } from '../../container/composition-root';
import { ServiceTokens } from '../../container/service-container';
import { IDocumentUploadService } from '../../interfaces/document-upload.interface';
import { ErrorHandler } from '../../interfaces/error-handler.interface';
import { createErrorContextFromEvent } from '../../utils/error-context';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();

  // Initialize structured logger with correlation ID
  const logger = initializeLogger(event, 'document-upload');
  const correlationId = logger.getCorrelationIdForLambda();

  logger.pipelineStage('UPLOAD_START', {
    httpMethod: event.httpMethod,
    path: event.path,
    userAgent: event.headers['User-Agent'] || event.headers['user-agent'],
    contentLength: event.headers['Content-Length'] || event.headers['content-length']
  }, 'Document upload request received');

  try {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      logger.info('CORS_PREFLIGHT', {}, 'CORS preflight request handled');
      return createResponse(200, { message: 'CORS preflight successful' });
    }

    if (event.httpMethod !== 'POST') {
      logger.warn('METHOD_NOT_ALLOWED', { 
        method: event.httpMethod,
        allowedMethods: ['POST', 'OPTIONS']
      }, `Method ${event.httpMethod} not allowed`);
      return createResponse(405, { error: 'Method not allowed' });
    }

    // Validate content type and extract boundary
    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      logger.warn('INVALID_CONTENT_TYPE', { 
        contentType: contentType,
        required: 'multipart/form-data'
      }, 'Invalid Content-Type header');
      return createResponse(400, { error: 'Content-Type must be multipart/form-data' });
    }

    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      logger.warn('MISSING_BOUNDARY', { contentType }, 'Missing boundary in Content-Type header');
      return createResponse(400, { error: 'Missing boundary in Content-Type header' });
    }

    const boundary = boundaryMatch[1];
    
    if (!event.body) {
      logger.warn('MISSING_BODY', {}, 'Request body is required');
      return createResponse(400, { error: 'Request body is required' });
    }

    // Get services from DI container
    const container = CompositionRoot.getContainer();
    const documentUploadService = container.resolve<IDocumentUploadService>(ServiceTokens.DOCUMENT_UPLOAD_SERVICE);

    // Process document upload through service
    const result = await documentUploadService.processDocumentUpload(
      event.body,
      boundary,
      correlationId
    );

    const totalTime = Date.now() - startTime;

    return createResponse(200, {
      success: result.success,
      document: {
        tenant_id: result.documentMetadata.tenant_id,
        asset_id: result.documentMetadata.asset_id,
        file_name: result.documentMetadata.file_name,
        file_size: result.documentMetadata.file_size,
        content_type: result.documentMetadata.content_type,
        status: result.documentMetadata.status,
        created_at: result.documentMetadata.created_at,
        s3_bucket: result.uploadedFile.bucket,
        s3_key: result.uploadedFile.key,
        correlation_id: correlationId,
      },
      processing_time: totalTime,
      message: `Document uploaded successfully.`,
    });

  } catch (error) {
    const totalTime = Date.now() - startTime;
    
    // Use standardized error handling
    const context = createErrorContextFromEvent(event, 'DOCUMENT_UPLOAD_PIPELINE', correlationId);
    context.metadata = {
      ...context.metadata,
      totalDuration: totalTime,
      pipelineStage: 'UPLOAD'
    };

    const container = CompositionRoot.getContainer();
    const errorHandler = container.resolve<ErrorHandler>(ServiceTokens.ERROR_HANDLER);
    const applicationError = errorHandler.handleError(error as Error, context);

    logger.performance('UPLOAD_FAILED', totalTime, {
      error: true,
      errorType: error instanceof Error ? error.name : 'Unknown',
      errorCode: applicationError.code,
      errorCategory: applicationError.category
    });

    // Return standardized error response
    return createApplicationErrorResponse(applicationError, true);
  }
};
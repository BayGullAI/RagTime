import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createResponse, createApplicationErrorResponse } from '../../utils/response.utils';
import { initializeLogger } from '../../utils/structured-logger';
import { CompositionRoot } from '../../container/composition-root';
import { ServiceTokens } from '../../container/service-container';
import { ITextProcessingService } from '../../interfaces/text-processing.interface';
import { ErrorHandler } from '../../interfaces/error-handler.interface';
import { ValidationError } from '../../utils/application-error';
import { createErrorContextFromEvent } from '../../utils/error-context';

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();

  // Initialize structured logger
  const logger = initializeLogger(event, 'text-processing');

  // Get correlation ID from logger (already extracted/generated)
  const correlationId = logger.getCorrelationIdForLambda();

  logger.pipelineStage('PROCESSING_START', {
    httpMethod: event.httpMethod,
    path: event.path,
    contentLength: event.headers['Content-Length'] || event.headers['content-length']
  }, 'Text processing request received');

  try {
    const body = JSON.parse(event.body || '{}');
    const { text, documentId, chunkSize = 1000, chunkOverlap = 200, fileName, s3Bucket, s3Key } = body;

    // Validate required fields using standardized error handling
    if (!text || !documentId) {
      const context = createErrorContextFromEvent(event, 'TEXT_PROCESSING_VALIDATION', correlationId);
      const validationError = new ValidationError(
        'Missing required fields: text and documentId are required',
        context,
        { hasText: !!text, hasDocumentId: !!documentId, requiredFields: ['text', 'documentId'] }
      );
      
      logger.warn('MISSING_REQUIRED_FIELDS', {
        hasText: !!text,
        hasDocumentId: !!documentId,
        requiredFields: ['text', 'documentId']
      }, 'Missing required fields for text processing');
      
      return createApplicationErrorResponse(validationError);
    }

    const wordCount = text.split(/\s+/).length;
    const characterCount = text.length;
    const estimatedChunks = Math.ceil(characterCount / chunkSize);

    logger.info('CONTENT_ANALYSIS', {
      documentId: documentId,
      fileName: fileName || 'unknown',
      wordCount: wordCount,
      characterCount: characterCount,
      estimatedChunks: estimatedChunks,
      chunkSize: chunkSize,
      chunkOverlap: chunkOverlap,
      contentType: 'text/plain',
      s3Bucket: s3Bucket || null,
      s3Key: s3Key || null
    }, `Content analysis completed`);

    // Get services from DI container
    const container = CompositionRoot.getContainer();
    const textProcessingService = container.resolve<ITextProcessingService>(
      ServiceTokens.TEXT_PROCESSING_SERVICE
    );
    const errorHandler = container.resolve<ErrorHandler>(ServiceTokens.ERROR_HANDLER);

    logger.info('CHUNKING_START', {
      documentId: documentId,
      chunkSize: chunkSize,
      overlap: chunkOverlap,
      strategy: 'paragraph-aware'
    }, `Starting document chunking`);

    const chunkingStartTime = Date.now();

    // Process the text
    const result = await textProcessingService.processDocument({
      text,
      documentId,
      chunkSize,
      chunkOverlap,
      correlationId,
      embeddingModel: 'text-embedding-3-small'
    });

    const chunkingTime = Date.now() - chunkingStartTime;
    const totalTime = Date.now() - startTime;

    logger.info('CHUNKING_COMPLETE', {
      documentId: documentId,
      fileName: fileName || 'unknown',
      chunkCount: result.chunks?.length || 0,
      chunks: result.chunks?.map((chunk: any, index: number) => ({
        chunkId: chunk.id || `${documentId}_chunk_${index}`,
        size: chunk.content?.length || 0,
        preview: chunk.content?.substring(0, 100) + '...' || '',
        wordCount: chunk.content?.split(/\s+/).length || 0
      })) || [],
      processingDuration: chunkingTime
    }, `Document successfully chunked into ${result.chunks?.length || 0} segments`);

    logger.pipelineStage('PROCESSING_COMPLETE', {
      documentId: documentId,
      status: 'CHUNKED',
      chunkCount: result.chunks?.length || 0,
      totalDuration: totalTime,
      nextStep: 'EMBEDDING_GENERATION'
    }, `Text processing pipeline completed`);

    logger.performance('TEXT_PROCESSING_TOTAL', totalTime, {
      documentId: documentId,
      chunkCount: result.chunks?.length || 0,
      wordCount: wordCount,
      characterCount: characterCount
    });

    return createResponse(200, {
      message: 'Text processed successfully',
      result: {
        ...result,
        correlation_id: correlationId,
        processing_time: totalTime
      }
    });

  } catch (error) {
    const totalTime = Date.now() - startTime;
    
    // Use standardized error handling
    const context = createErrorContextFromEvent(
      event, 
      'TEXT_PROCESSING_PIPELINE', 
      correlationId
    );
    context.metadata = {
      ...context.metadata,
      totalDuration: totalTime,
      pipelineStage: 'TEXT_PROCESSING'
    };

    const container = CompositionRoot.getContainer();
    const errorHandler = container.resolve<ErrorHandler>(ServiceTokens.ERROR_HANDLER);
    const applicationError = errorHandler.handleError(error as Error, context);

    logger.performance('PROCESSING_FAILED', totalTime, {
      error: true,
      errorType: error instanceof Error ? error.name : 'Unknown',
      errorCode: applicationError.code,
      errorCategory: applicationError.category
    });

    // Return standardized error response (includes debug info in development)
    return createApplicationErrorResponse(applicationError, true);
  }
};
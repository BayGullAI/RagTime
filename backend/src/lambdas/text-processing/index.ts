import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createResponse } from '../../utils/response.utils';
import { TextProcessingService } from '../../services/text-processing.service';
import { OpenAIService } from '../../services/openai.service';
import { initializeLogger } from '../../utils/structured-logger';
import { 
  generateCorrelationId, 
  extractCorrelationIdFromEvent 
} from '../../utils/correlation';

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();

  // Initialize structured logger
  const logger = initializeLogger(event, 'text-processing');

  // Extract or generate correlation ID
  let correlationId = extractCorrelationIdFromEvent(event);
  if (!correlationId) {
    correlationId = generateCorrelationId('PROC');
    logger.setCorrelationId(correlationId);
  }

  logger.pipelineStage('PROCESSING_START', {
    httpMethod: event.httpMethod,
    path: event.path,
    contentLength: event.headers['Content-Length'] || event.headers['content-length']
  }, 'Text processing request received');

  try {
    const body = JSON.parse(event.body || '{}');
    const { text, documentId, chunkSize = 1000, chunkOverlap = 200, fileName, s3Bucket, s3Key } = body;

    if (!text || !documentId) {
      logger.warn('MISSING_REQUIRED_FIELDS', {
        hasText: !!text,
        hasDocumentId: !!documentId,
        requiredFields: ['text', 'documentId']
      }, 'Missing required fields for text processing');
      
      return createResponse(400, {
        error: 'Missing required fields: text and documentId'
      });
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

    // Initialize services
    const openAIService = new OpenAIService();
    const textProcessingService = new TextProcessingService(openAIService);

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
    
    logger.logError('PROCESSING_FAILED', error as Error, {
      totalDuration: totalTime,
      pipelineStage: 'TEXT_PROCESSING'
    });

    logger.performance('PROCESSING_FAILED', totalTime, {
      error: true,
      errorType: error instanceof Error ? error.name : 'Unknown'
    });

    return createResponse(500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
      correlation_id: correlationId,
      processing_time: totalTime
    });
  }
};
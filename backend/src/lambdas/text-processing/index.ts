import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createResponse } from '../../utils/response.utils';
import { TextProcessingService } from '../../services/text-processing.service';
import { OpenAIService } from '../../services/openai.service';
import { initializeLogger } from '../../utils/structured-logger';
import { 
  generateCorrelationId, 
  extractCorrelationIdFromEvent 
} from '../../utils/correlation';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

async function updateDocumentStatusToProcessed(
  tenantId: string,
  assetId: string,
  logger: any
): Promise<void> {
  const now = new Date().toISOString();
  const updateStartTime = Date.now();
  
  logger.info('STATUS_UPDATE_TO_PROCESSED_START', {
    documentId: assetId,
    tenantId: tenantId,
    newStatus: 'PROCESSED'
  }, 'Starting DynamoDB status update to PROCESSED');

  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: process.env.DOCUMENTS_TABLE_NAME!,
      Key: {
        tenant_id: tenantId,
        asset_id: assetId,
      },
      UpdateExpression: 'SET #status = :status, updated_at = :updated_at, gsi2_pk = :gsi2_pk, gsi2_sk = :gsi2_sk',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': 'PROCESSED',
        ':updated_at': now,
        ':gsi2_pk': `${tenantId}#PROCESSED`,
        ':gsi2_sk': `${now}#${assetId}`,
      },
    }));

    const updateDuration = Date.now() - updateStartTime;

    logger.info('STATUS_UPDATED_TO_PROCESSED', {
      documentId: assetId,
      tenantId: tenantId,
      newStatus: 'PROCESSED',
      updateDuration: updateDuration
    }, 'Document status updated to PROCESSED in DynamoDB');

    logger.performance('DYNAMODB_STATUS_UPDATE', updateDuration, {
      operation: 'updateStatusToProcessed',
      documentId: assetId,
      status: 'PROCESSED'
    });

  } catch (error) {
    const updateDuration = Date.now() - updateStartTime;
    logger.logError('STATUS_UPDATE_TO_PROCESSED_FAILED', error as Error, {
      documentId: assetId,
      tenantId: tenantId,
      newStatus: 'PROCESSED',
      updateDuration: updateDuration
    });
    throw new Error('Failed to update document status to PROCESSED in DynamoDB');
  }
}

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
    const { text, documentId, chunkSize = 1000, chunkOverlap = 200, fileName, s3Bucket, s3Key, tenantId } = body;

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
    const textProcessingService = new TextProcessingService(openAIService, logger);

    logger.pipelineStage('STEP3_CHUNKING_START', {
      documentId: documentId,
      chunkSize: chunkSize,
      overlap: chunkOverlap,
      strategy: 'paragraph-aware',
      step: '3/5',
      stepName: 'CHUNKS_CREATION'
    }, `Pipeline Step 3/5: Starting document chunking`);

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
      embeddingModel: 'text-embedding-3-small',
      fileName
    });

    const chunkingTime = Date.now() - chunkingStartTime;
    const totalTime = Date.now() - startTime;

    logger.pipelineStage('STEP3_CHUNKING_COMPLETE', {
      documentId: documentId,
      fileName: fileName || 'unknown',
      chunkCount: result.chunks?.length || 0,
      processingDuration: chunkingTime,
      step: '3/5',
      stepName: 'CHUNKS_CREATION',
      nextStep: 'EMBEDDINGS_GENERATION'
    }, `Pipeline Step 3/5 Complete: Document chunked into ${result.chunks?.length || 0} segments`);

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

    logger.pipelineStage('STEP5_PIPELINE_COMPLETE', {
      documentId: documentId,
      status: 'PROCESSED',
      chunkCount: result.chunks?.length || 0,
      totalDuration: totalTime,
      step: '5/5',
      stepName: 'PIPELINE_COMPLETE',
      allStepsCompleted: ['DYNAMODB_ENTRY', 'S3_STORAGE', 'CHUNKS_CREATION', 'EMBEDDINGS_GENERATION', 'PGVECTOR_STORAGE']
    }, `Pipeline Step 5/5 Complete: All processing stages completed successfully`);

    logger.pipelineStage('PROCESSING_COMPLETE', {
      documentId: documentId,
      status: 'CHUNKED',
      chunkCount: result.chunks?.length || 0,
      totalDuration: totalTime,
      nextStep: 'COMPLETE'
    }, `Text processing pipeline completed`);

    logger.performance('TEXT_PROCESSING_TOTAL', totalTime, {
      documentId: documentId,
      chunkCount: result.chunks?.length || 0,
      wordCount: wordCount,
      characterCount: characterCount
    });

    // Update DynamoDB document status to PROCESSED
    if (tenantId) {
      try {
        await updateDocumentStatusToProcessed(tenantId, documentId, logger);
        
        logger.pipelineStage('STEP6_DYNAMODB_STATUS_UPDATE', {
          documentId: documentId,
          tenantId: tenantId,
          finalStatus: 'PROCESSED',
          step: '6/6',
          stepName: 'STATUS_UPDATE_COMPLETE'
        }, `Pipeline Step 6/6: DynamoDB status updated to PROCESSED`);
        
      } catch (statusError) {
        logger.logError('DYNAMODB_STATUS_UPDATE_WARNING', statusError as Error, {
          documentId: documentId,
          tenantId: tenantId,
          message: 'Failed to update DynamoDB status, but processing completed successfully'
        });
        // Continue without failing the entire operation
      }
    } else {
      logger.warn('MISSING_TENANT_ID', {
        documentId: documentId
      }, 'Cannot update DynamoDB status - tenant_id not provided');
    }

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
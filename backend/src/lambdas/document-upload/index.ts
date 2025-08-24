import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { v4 as uuidv4 } from 'uuid';
import { createResponse, createErrorResponse } from '../../utils/response.utils';
import { initializeLogger, StructuredLogger } from '../../utils/structured-logger';
// Phase 2: Dependency injection system implemented - correlation ID handling via initializeLogger

interface DocumentMetadata {
  tenant_id: string;
  asset_id: string;
  file_name: string;
  file_size: number;
  content_type: string;
  s3_bucket: string;
  s3_key: string;
  status: 'UPLOADED' | 'PROCESSED' | 'FAILED';
  created_at: string;
  updated_at: string;
  error_message?: string;
  correlation_id: string;
  source_url?: string;
  extraction_method?: string;
  word_count?: number;
  gsi1_sk: string; // For time-based queries: created_at#asset_id
  gsi2_pk: string; // For status-based queries: tenant_id#status
  gsi2_sk: string; // For status-based queries: created_at#asset_id
}

const s3Client = new S3Client({ region: process.env.AWS_REGION });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const SUPPORTED_CONTENT_TYPES = [
  'text/plain',
  'application/pdf', // Future support
  'application/msword', // Future support
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // Future support
];

function parseMultipartFormData(body: string, boundary: string): { 
  files: Array<{ 
    filename: string; 
    contentType: string; 
    content: Buffer; 
  }>; 
  fields: Record<string, string>; 
} {
  const parts = body.split(`--${boundary}`);
  const files: Array<{ filename: string; contentType: string; content: Buffer; }> = [];
  const fields: Record<string, string> = {};

  for (const part of parts) {
    if (!part.trim() || part.trim() === '--') continue;

    const headerEndIndex = part.indexOf('\r\n\r\n');
    if (headerEndIndex === -1) continue;

    const headers = part.substring(0, headerEndIndex);
    const content = part.substring(headerEndIndex + 4);

    const dispositionMatch = headers.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]+)")?/i);
    if (!dispositionMatch) continue;

    const fieldName = dispositionMatch[1];
    const filename = dispositionMatch[2];

    if (filename) {
      // File field
      const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
      const contentType = contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream';
      
      files.push({
        filename,
        contentType,
        content: Buffer.from(content.substring(0, content.length - 2), 'binary'), // Remove trailing \r\n
      });
    } else {
      // Regular field
      fields[fieldName] = content.substring(0, content.length - 2); // Remove trailing \r\n
    }
  }

  return { files, fields };
}

function validateInput(fields: Record<string, string>, files: Array<{ filename: string; contentType: string; content: Buffer; }>): {
  tenantId: string;
  file: { filename: string; contentType: string; content: Buffer; };
} {
  // Validate tenant_id
  const tenantId = fields.tenant_id;
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('tenant_id is required');
  }

  // Sanitize tenant_id - allow only alphanumeric, hyphens, underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(tenantId) || tenantId.length > 50) {
    throw new Error('tenant_id must contain only alphanumeric characters, hyphens, and underscores (max 50 chars)');
  }

  // Validate file
  if (!files || files.length === 0) {
    throw new Error('file is required');
  }

  if (files.length > 1) {
    throw new Error('Only one file upload is supported');
  }

  const file = files[0];

  // Validate file size
  if (file.content.length > MAX_FILE_SIZE) {
    throw new Error(`File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
  }

  if (file.content.length === 0) {
    throw new Error('File cannot be empty');
  }

  // Validate content type
  if (!SUPPORTED_CONTENT_TYPES.includes(file.contentType)) {
    throw new Error(`Unsupported file type. Supported types: ${SUPPORTED_CONTENT_TYPES.join(', ')}`);
  }

  // Validate filename
  if (!file.filename || file.filename.length > 255) {
    throw new Error('Invalid filename (max 255 characters)');
  }

  // Sanitize filename - remove dangerous characters
  const sanitizedFilename = file.filename.replace(/[<>:"/\\|?*]/g, '_');
  
  return {
    tenantId,
    file: {
      ...file,
      filename: sanitizedFilename,
    },
  };
}

async function uploadToS3(
  file: { filename: string; contentType: string; content: Buffer; },
  assetId: string,
  tenantId: string,
  logger: StructuredLogger
): Promise<{ bucket: string; key: string; }> {
  const bucket = process.env.DOCUMENTS_BUCKET_NAME!;
  const key = `documents/${tenantId}/${assetId}/${file.filename}`;
  const uploadStartTime = Date.now();

  logger.info('S3_UPLOAD_START', {
    fileName: file.filename,
    fileSize: file.content.length,
    contentType: file.contentType,
    s3Bucket: bucket,
    s3Key: key,
    tenantId: tenantId,
    assetId: assetId
  }, `Starting S3 upload for ${file.filename}`);

  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: file.content,
      ContentType: file.contentType,
      Metadata: {
        'tenant-id': tenantId,
        'asset-id': assetId,
        'original-filename': file.filename,
      },
    }));

    const uploadDuration = Date.now() - uploadStartTime;

    logger.info('S3_UPLOAD_SUCCESS', {
      fileName: file.filename,
      s3Bucket: bucket,
      s3Key: key,
      fileSize: file.content.length,
      uploadDuration: uploadDuration,
      tenantId: tenantId,
      assetId: assetId
    }, `File successfully uploaded to S3`);

    logger.performance('S3_UPLOAD', uploadDuration, {
      fileName: file.filename,
      fileSize: file.content.length
    });

    return { bucket, key };
  } catch (error) {
    const uploadDuration = Date.now() - uploadStartTime;
    logger.logError('S3_UPLOAD_FAILED', error as Error, {
      fileName: file.filename,
      s3Bucket: bucket,
      s3Key: key,
      fileSize: file.content.length,
      uploadDuration: uploadDuration,
      tenantId: tenantId,
      assetId: assetId
    });
    throw new Error('Failed to upload file to storage');
  }
}

async function saveDocumentMetadata(metadata: DocumentMetadata, logger: StructuredLogger): Promise<void> {
  const saveStartTime = Date.now();

  logger.info('METADATA_SAVE_START', {
    documentId: metadata.asset_id,
    tenantId: metadata.tenant_id,
    fileName: metadata.file_name,
    status: metadata.status,
    dbTable: process.env.DOCUMENTS_TABLE_NAME
  }, `Starting metadata save for ${metadata.file_name}`);

  try {
    await dynamoClient.send(new PutCommand({
      TableName: process.env.DOCUMENTS_TABLE_NAME!,
      Item: metadata,
    }));

    const saveDuration = Date.now() - saveStartTime;

    logger.info('METADATA_SAVED', {
      documentId: metadata.asset_id,
      tenantId: metadata.tenant_id,
      status: metadata.status,
      fileName: metadata.file_name,
      correlationId: metadata.correlation_id,
      sourceUrl: metadata.source_url || null,
      dbTable: process.env.DOCUMENTS_TABLE_NAME,
      saveDuration: saveDuration
    }, `Document metadata saved to DynamoDB`);

    logger.performance('DYNAMODB_PUT', saveDuration, {
      operation: 'saveDocumentMetadata',
      documentId: metadata.asset_id
    });

  } catch (error) {
    const saveDuration = Date.now() - saveStartTime;
    logger.logError('METADATA_SAVE_FAILED', error as Error, {
      documentId: metadata.asset_id,
      tenantId: metadata.tenant_id,
      fileName: metadata.file_name,
      dbTable: process.env.DOCUMENTS_TABLE_NAME,
      saveDuration: saveDuration
    });
    throw new Error('Failed to save document metadata');
  }
}

async function updateDocumentStatus(
  tenantId: string,
  assetId: string,
  status: DocumentMetadata['status'],
  logger: StructuredLogger,
  errorMessage?: string
): Promise<void> {
  const now = new Date().toISOString();
  const updateStartTime = Date.now();
  
  logger.info('STATUS_UPDATE_START', {
    documentId: assetId,
    tenantId: tenantId,
    newStatus: status,
    errorMessage: errorMessage || null
  }, `Starting status update to ${status}`);

  try {
    const updateParams: any = {
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
        ':status': status,
        ':updated_at': now,
        ':gsi2_pk': `${tenantId}#${status}`,
        ':gsi2_sk': `${now}#${assetId}`,
      },
    };

    if (errorMessage) {
      updateParams.UpdateExpression += ', error_message = :error_message';
      updateParams.ExpressionAttributeValues[':error_message'] = errorMessage;
    }

    await dynamoClient.send(new UpdateCommand(updateParams));

    const updateDuration = Date.now() - updateStartTime;

    logger.info('STATUS_UPDATED', {
      documentId: assetId,
      tenantId: tenantId,
      newStatus: status,
      errorMessage: errorMessage || null,
      updateDuration: updateDuration,
      nextStep: status === 'PROCESSED' ? 'COMPLETE' : 'TEXT_PROCESSING'
    }, `Document status updated to ${status}`);

    logger.performance('DYNAMODB_UPDATE', updateDuration, {
      operation: 'updateDocumentStatus',
      documentId: assetId,
      status: status
    });

  } catch (error) {
    const updateDuration = Date.now() - updateStartTime;
    logger.logError('STATUS_UPDATE_FAILED', error as Error, {
      documentId: assetId,
      tenantId: tenantId,
      newStatus: status,
      updateDuration: updateDuration
    });
    throw new Error('Failed to update document status');
  }
}

async function triggerTextProcessing(
  file: { filename: string; contentType: string; content: Buffer; },
  assetId: string,
  s3Bucket: string,
  s3Key: string,
  correlationId: string,
  logger: StructuredLogger
): Promise<void> {
  const processStartTime = Date.now();

  logger.info('TEXT_PROCESSING_START', {
    documentId: assetId,
    fileName: file.filename,
    s3Bucket: s3Bucket,
    s3Key: s3Key,
    textProcessingLambda: process.env.TEXT_PROCESSING_LAMBDA_NAME
  }, `Triggering text processing for ${file.filename}`);

  try {
    // For text files, use the content directly
    let textContent: string;
    if (file.contentType === 'text/plain') {
      textContent = file.content.toString('utf-8');
    } else {
      throw new Error(`Unsupported content type for text processing: ${file.contentType}`);
    }

    const payload = {
      text: textContent,
      documentId: assetId,
      fileName: file.filename,
      s3Bucket: s3Bucket,
      s3Key: s3Key,
      chunkSize: 1000,
      chunkOverlap: 200,
      correlationId: correlationId
    };

    // Invoke text processing Lambda synchronously (blocking call)
    const command = new InvokeCommand({
      FunctionName: process.env.TEXT_PROCESSING_LAMBDA_NAME!,
      InvocationType: 'RequestResponse', // Synchronous invocation - blocks until completion
      Payload: JSON.stringify({
        httpMethod: 'POST',
        body: JSON.stringify(payload),
        headers: {
          'Content-Type': 'application/json',
          'X-Correlation-ID': correlationId
        }
      }),
    });

    const response = await lambdaClient.send(command);
    const processDuration = Date.now() - processStartTime;

    if (response.StatusCode !== 200) {
      throw new Error(`Text processing Lambda returned status ${response.StatusCode}`);
    }

    const responsePayload = response.Payload ? JSON.parse(new TextDecoder().decode(response.Payload)) : {};
    
    if (responsePayload.statusCode && responsePayload.statusCode !== 200) {
      const errorMessage = typeof responsePayload.body === 'string' ? 
        responsePayload.body : 
        JSON.stringify(responsePayload.body || 'Unknown error');
      throw new Error(`Text processing failed: ${errorMessage}`);
    }

    logger.info('TEXT_PROCESSING_SUCCESS', {
      documentId: assetId,
      fileName: file.filename,
      processingDuration: processDuration,
      lambdaStatusCode: response.StatusCode,
      chunksGenerated: responsePayload.result?.totalChunks || 0,
      totalTokens: responsePayload.result?.totalTokens || 0
    }, `Text processing completed successfully - ${responsePayload.result?.totalChunks || 0} chunks generated`);

    logger.performance('TEXT_PROCESSING', processDuration, {
      fileName: file.filename,
      documentId: assetId,
      textLength: textContent.length,
      chunksGenerated: responsePayload.result?.totalChunks || 0
    });

  } catch (error) {
    const processDuration = Date.now() - processStartTime;
    logger.logError('TEXT_PROCESSING_FAILED', error as Error, {
      documentId: assetId,
      fileName: file.filename,
      s3Bucket: s3Bucket,
      s3Key: s3Key,
      processingDuration: processDuration,
      textProcessingLambda: process.env.TEXT_PROCESSING_LAMBDA_NAME
    });
    throw new Error(`Text processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}



export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();
  let assetId: string | undefined;
  let tenantId: string | undefined;

  // Initialize structured logger with correlation ID
  const logger = initializeLogger(event, 'document-upload');
  
  // Get correlation ID from logger (already extracted/generated)
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

    // Validate content type
    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      logger.warn('INVALID_CONTENT_TYPE', { 
        contentType: contentType,
        required: 'multipart/form-data'
      }, 'Invalid Content-Type header');
      return createResponse(400, { error: 'Content-Type must be multipart/form-data' });
    }

    // Extract boundary
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

    logger.info('PARSING_MULTIPART', {
      bodyLength: event.body.length,
      boundary: boundary
    }, 'Starting multipart form data parsing');

    // Parse multipart form data
    const { files, fields } = parseMultipartFormData(event.body, boundary);
    
    logger.info('MULTIPART_PARSED', {
      fileCount: files.length,
      fieldCount: Object.keys(fields).length,
      fields: Object.keys(fields)
    }, 'Multipart form data parsed successfully');

    // Validate input
    const { tenantId: validatedTenantId, file } = validateInput(fields, files);
    tenantId = validatedTenantId;

    // Generate unique asset ID
    assetId = uuidv4();
    const now = new Date().toISOString();

    logger.info('UPLOAD_START', {
      fileName: file.filename,
      fileSize: file.content.length,
      contentType: file.contentType,
      tenantId: tenantId,
      assetId: assetId,
      sourceUrl: null,
      extractionMethod: 'direct'
    }, `Starting upload for ${file.filename}`);

    // Upload file to S3
    const { bucket, key } = await uploadToS3(file, assetId, tenantId, logger);

    // Create initial document metadata with correlation tracking
    const documentMetadata: DocumentMetadata = {
      tenant_id: tenantId,
      asset_id: assetId,
      file_name: file.filename,
      file_size: file.content.length,
      content_type: file.contentType,
      s3_bucket: bucket,
      s3_key: key,
      status: 'UPLOADED',
      created_at: now,
      updated_at: now,
      correlation_id: correlationId,
      extraction_method: 'direct',
      word_count: file.contentType === 'text/plain' ? file.content.toString().split(/\s+/).length : undefined,
      gsi1_sk: `${now}#${assetId}`,
      gsi2_pk: `${tenantId}#UPLOADED`,
      gsi2_sk: `${now}#${assetId}`,
    };

    // Save metadata to DynamoDB
    await saveDocumentMetadata(documentMetadata, logger);

    // Trigger text processing (this will block until completion)
    try {
      await triggerTextProcessing(file, assetId, bucket, key, correlationId, logger);
      
      // Only mark as PROCESSED after text processing succeeds
      await updateDocumentStatus(tenantId, assetId, 'PROCESSED', logger);
      
      logger.pipelineStage('TEXT_PROCESSING_PIPELINE_COMPLETE', {
        documentId: assetId,
        fileName: file.filename,
        status: 'PROCESSED'
      }, 'Text processing pipeline completed successfully');
      
    } catch (textProcessingError) {
      // Mark as FAILED if text processing fails
      await updateDocumentStatus(tenantId, assetId, 'FAILED', logger, 
        `Text processing failed: ${textProcessingError instanceof Error ? textProcessingError.message : 'Unknown error'}`);
      
      throw textProcessingError;
    }

    const totalTime = Date.now() - startTime;

    logger.pipelineStage('UPLOAD_COMPLETE', {
      fileName: file.filename,
      documentId: assetId,
      totalDuration: totalTime,
      s3Location: `s3://${bucket}/${key}`,
      nextStep: 'COMPLETE'
    }, `Upload pipeline completed successfully`);

    logger.performance('UPLOAD_TOTAL', totalTime, {
      fileName: file.filename,
      fileSize: file.content.length,
      documentId: assetId
    });

    return createResponse(200, {
      success: true,
      document: {
        tenant_id: tenantId,
        asset_id: assetId,
        file_name: file.filename,
        file_size: file.content.length,
        content_type: file.contentType,
        status: 'PROCESSED',
        created_at: now,
        s3_bucket: bucket,
        s3_key: key,
        correlation_id: correlationId,
      },
      processing_time: totalTime,
      message: `Document uploaded successfully.`,
    });

  } catch (error) {
    const totalTime = Date.now() - startTime;
    
    logger.logError('UPLOAD_FAILED', error as Error, {
      fileName: tenantId && assetId ? 'unknown' : undefined,
      tenantId: tenantId,
      documentId: assetId,
      totalDuration: totalTime,
      pipelineStage: 'UPLOAD'
    });
    
    // If we have tenant and asset IDs, try to update status to FAILED
    if (tenantId && assetId) {
      try {
        await updateDocumentStatus(tenantId, assetId, 'FAILED', logger, error instanceof Error ? error.message : 'Unknown error');
      } catch (updateError) {
        logger.logError('STATUS_UPDATE_AFTER_FAILURE', updateError as Error, {
          documentId: assetId,
          tenantId: tenantId,
          originalError: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    logger.performance('UPLOAD_FAILED', totalTime, {
      error: true,
      errorType: error instanceof Error ? error.name : 'Unknown',
      documentId: assetId || 'unknown'
    });

    return createErrorResponse(
      500,
      'Document upload failed',
      error instanceof Error ? error.message : 'Unknown error occurred',
      { processing_time: totalTime, correlation_id: correlationId }
    );
  }
};
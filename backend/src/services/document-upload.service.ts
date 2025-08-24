/**
 * Document Upload Service Implementation
 * Phase 4: Business logic extraction from Lambda functions
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  IDocumentUploadService,
  MultipartFile,
  ParsedMultipartData,
  ValidatedUploadInput,
  UploadedFile,
  DocumentMetadata,
  ProcessingResult
} from '../interfaces/document-upload.interface';
import { ValidationError, InfrastructureError, ExternalApiError } from '../utils/application-error';
import { createErrorContext } from '../utils/error-context';
import { StructuredLogger } from '../utils/structured-logger';

export class DocumentUploadService implements IDocumentUploadService {
  private s3Client: S3Client;
  private dynamoClient: DynamoDBDocumentClient;
  private lambdaClient: LambdaClient;
  private logger: StructuredLogger;

  private readonly MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
  private readonly SUPPORTED_CONTENT_TYPES = [
    'text/plain',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];

  constructor(logger: StructuredLogger) {
    this.s3Client = new S3Client({ region: process.env.AWS_REGION });
    this.dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
    this.lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });
    this.logger = logger;
  }

  /**
   * Parse multipart form data from HTTP request body
   */
  parseMultipartFormData(body: string, boundary: string): ParsedMultipartData {
    const parts = body.split(`--${boundary}`);
    const files: MultipartFile[] = [];
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
          content: Buffer.from(content.substring(0, content.length - 2), 'binary')
        });
      } else {
        // Regular field
        fields[fieldName] = content.substring(0, content.length - 2);
      }
    }

    return { files, fields };
  }

  /**
   * Validate upload input fields and files
   */
  validateUploadInput(fields: Record<string, string>, files: MultipartFile[]): ValidatedUploadInput {
    const context = createErrorContext('UPLOAD_VALIDATION');

    // Validate tenant_id
    const tenantId = fields.tenant_id;
    if (!tenantId || typeof tenantId !== 'string') {
      throw new ValidationError('tenant_id is required', context);
    }

    // Sanitize tenant_id - allow only alphanumeric, hyphens, underscores
    if (!/^[a-zA-Z0-9_-]+$/.test(tenantId) || tenantId.length > 50) {
      throw new ValidationError(
        'tenant_id must contain only alphanumeric characters, hyphens, and underscores (max 50 chars)',
        context
      );
    }

    // Validate file
    if (!files || files.length === 0) {
      throw new ValidationError('file is required', context);
    }

    if (files.length > 1) {
      throw new ValidationError('Only one file upload is supported', context);
    }

    const file = files[0];

    // Validate file size
    if (file.content.length > this.MAX_FILE_SIZE) {
      throw new ValidationError(
        `File too large. Maximum size is ${this.MAX_FILE_SIZE / (1024 * 1024)}MB`,
        context
      );
    }

    if (file.content.length === 0) {
      throw new ValidationError('File cannot be empty', context);
    }

    // Validate content type
    if (!this.SUPPORTED_CONTENT_TYPES.includes(file.contentType)) {
      throw new ValidationError(
        `Unsupported file type. Supported types: ${this.SUPPORTED_CONTENT_TYPES.join(', ')}`,
        context
      );
    }

    // Validate filename
    if (!file.filename || file.filename.length > 255) {
      throw new ValidationError('Invalid filename (max 255 characters)', context);
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

  /**
   * Upload file to S3 storage
   */
  async uploadToS3(file: MultipartFile, assetId: string, tenantId: string, correlationId: string): Promise<UploadedFile> {
    const bucket = process.env.DOCUMENTS_BUCKET_NAME!;
    const key = `documents/${tenantId}/${assetId}/${file.filename}`;
    const uploadStartTime = Date.now();
    const context = createErrorContext('S3_UPLOAD', correlationId);

    this.logger.info('S3_UPLOAD_START', {
      fileName: file.filename,
      fileSize: file.content.length,
      contentType: file.contentType,
      s3Bucket: bucket,
      s3Key: key,
      tenantId: tenantId,
      assetId: assetId
    }, `Starting S3 upload for ${file.filename}`);

    try {
      await this.s3Client.send(new PutObjectCommand({
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

      this.logger.info('S3_UPLOAD_SUCCESS', {
        fileName: file.filename,
        s3Bucket: bucket,
        s3Key: key,
        fileSize: file.content.length,
        uploadDuration: uploadDuration,
        tenantId: tenantId,
        assetId: assetId
      }, `File successfully uploaded to S3`);

      this.logger.performance('S3_UPLOAD', uploadDuration, {
        fileName: file.filename,
        fileSize: file.content.length
      });

      return { bucket, key };

    } catch (error) {
      const uploadDuration = Date.now() - uploadStartTime;
      
      this.logger.logError('S3_UPLOAD_FAILED', error as Error, {
        fileName: file.filename,
        s3Bucket: bucket,
        s3Key: key,
        fileSize: file.content.length,
        uploadDuration: uploadDuration,
        tenantId: tenantId,
        assetId: assetId
      });

      throw new InfrastructureError(
        `Failed to upload file to S3: ${error instanceof Error ? error.message : 'Unknown error'}`,
        context,
        error as Error
      );
    }
  }

  /**
   * Save document metadata to database
   */
  async saveDocumentMetadata(metadata: DocumentMetadata, correlationId: string): Promise<void> {
    const saveStartTime = Date.now();
    const context = createErrorContext('METADATA_SAVE', correlationId);

    this.logger.info('METADATA_SAVE_START', {
      documentId: metadata.asset_id,
      tenantId: metadata.tenant_id,
      fileName: metadata.file_name,
      status: metadata.status,
      dbTable: process.env.DOCUMENTS_TABLE_NAME
    }, `Starting metadata save for ${metadata.file_name}`);

    try {
      await this.dynamoClient.send(new PutCommand({
        TableName: process.env.DOCUMENTS_TABLE_NAME!,
        Item: metadata,
      }));

      const saveDuration = Date.now() - saveStartTime;

      this.logger.info('METADATA_SAVED', {
        documentId: metadata.asset_id,
        tenantId: metadata.tenant_id,
        status: metadata.status,
        fileName: metadata.file_name,
        correlationId: metadata.correlation_id,
        sourceUrl: metadata.source_url || null,
        dbTable: process.env.DOCUMENTS_TABLE_NAME,
        saveDuration: saveDuration
      }, `Document metadata saved to DynamoDB`);

      this.logger.performance('DYNAMODB_PUT', saveDuration, {
        operation: 'saveDocumentMetadata',
        documentId: metadata.asset_id
      });

    } catch (error) {
      const saveDuration = Date.now() - saveStartTime;
      
      this.logger.logError('METADATA_SAVE_FAILED', error as Error, {
        documentId: metadata.asset_id,
        tenantId: metadata.tenant_id,
        fileName: metadata.file_name,
        dbTable: process.env.DOCUMENTS_TABLE_NAME,
        saveDuration: saveDuration
      });

      throw new InfrastructureError(
        `Failed to save document metadata: ${error instanceof Error ? error.message : 'Unknown error'}`,
        context,
        error as Error
      );
    }
  }

  /**
   * Update document status in database
   */
  async updateDocumentStatus(
    tenantId: string,
    assetId: string,
    status: DocumentMetadata['status'],
    correlationId: string,
    errorMessage?: string
  ): Promise<void> {
    const now = new Date().toISOString();
    const updateStartTime = Date.now();
    const context = createErrorContext('STATUS_UPDATE', correlationId);
    
    this.logger.info('STATUS_UPDATE_START', {
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

      await this.dynamoClient.send(new UpdateCommand(updateParams));

      const updateDuration = Date.now() - updateStartTime;

      this.logger.info('STATUS_UPDATED', {
        documentId: assetId,
        tenantId: tenantId,
        newStatus: status,
        errorMessage: errorMessage || null,
        updateDuration: updateDuration,
        nextStep: status === 'PROCESSED' ? 'COMPLETE' : 'TEXT_PROCESSING'
      }, `Document status updated to ${status}`);

      this.logger.performance('DYNAMODB_UPDATE', updateDuration, {
        operation: 'updateDocumentStatus',
        documentId: assetId,
        status: status
      });

    } catch (error) {
      const updateDuration = Date.now() - updateStartTime;
      
      this.logger.logError('STATUS_UPDATE_FAILED', error as Error, {
        documentId: assetId,
        tenantId: tenantId,
        newStatus: status,
        updateDuration: updateDuration
      });

      throw new InfrastructureError(
        `Failed to update document status: ${error instanceof Error ? error.message : 'Unknown error'}`,
        context,
        error as Error
      );
    }
  }

  /**
   * Trigger text processing pipeline
   */
  async triggerTextProcessing(
    file: MultipartFile,
    assetId: string,
    s3Bucket: string,
    s3Key: string,
    correlationId: string
  ): Promise<void> {
    const processStartTime = Date.now();
    const context = createErrorContext('TEXT_PROCESSING_TRIGGER', correlationId);

    this.logger.info('TEXT_PROCESSING_START', {
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
        throw new ValidationError(
          `Unsupported content type for text processing: ${file.contentType}`,
          context
        );
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

      // Invoke text processing Lambda synchronously
      const command = new InvokeCommand({
        FunctionName: process.env.TEXT_PROCESSING_LAMBDA_NAME!,
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({
          httpMethod: 'POST',
          body: JSON.stringify(payload),
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-ID': correlationId
          }
        }),
      });

      const response = await this.lambdaClient.send(command);
      const processDuration = Date.now() - processStartTime;

      if (response.StatusCode !== 200) {
        throw new ExternalApiError(
          'TextProcessingLambda',
          response.StatusCode || 500,
          `Text processing Lambda returned status ${response.StatusCode}`,
          context
        );
      }

      const responsePayload = response.Payload ? JSON.parse(new TextDecoder().decode(response.Payload)) : {};
      
      if (responsePayload.statusCode && responsePayload.statusCode !== 200) {
        const errorMessage = typeof responsePayload.body === 'string' ? 
          responsePayload.body : 
          JSON.stringify(responsePayload.body || 'Unknown error');
        
        throw new ExternalApiError(
          'TextProcessingLambda',
          responsePayload.statusCode,
          `Text processing failed: ${errorMessage}`,
          context
        );
      }

      this.logger.info('TEXT_PROCESSING_SUCCESS', {
        documentId: assetId,
        fileName: file.filename,
        processingDuration: processDuration,
        lambdaStatusCode: response.StatusCode,
        chunksGenerated: responsePayload.result?.totalChunks || 0,
        totalTokens: responsePayload.result?.totalTokens || 0
      }, `Text processing completed successfully - ${responsePayload.result?.totalChunks || 0} chunks generated`);

      this.logger.performance('TEXT_PROCESSING', processDuration, {
        fileName: file.filename,
        documentId: assetId,
        textLength: textContent.length,
        chunksGenerated: responsePayload.result?.totalChunks || 0
      });

    } catch (error) {
      const processDuration = Date.now() - processStartTime;
      
      this.logger.logError('TEXT_PROCESSING_FAILED', error as Error, {
        documentId: assetId,
        fileName: file.filename,
        s3Bucket: s3Bucket,
        s3Key: s3Key,
        processingDuration: processDuration,
        textProcessingLambda: process.env.TEXT_PROCESSING_LAMBDA_NAME
      });

      throw new InfrastructureError(
        `Text processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        context,
        error as Error
      );
    }
  }

  /**
   * Orchestrate the entire document upload and processing pipeline
   */
  async processDocumentUpload(
    requestBody: string,
    boundary: string,
    correlationId: string
  ): Promise<ProcessingResult> {
    const startTime = Date.now();

    // Parse multipart form data
    const { files, fields } = this.parseMultipartFormData(requestBody, boundary);
    
    this.logger.info('MULTIPART_PARSED', {
      fileCount: files.length,
      fieldCount: Object.keys(fields).length,
      fields: Object.keys(fields)
    }, 'Multipart form data parsed successfully');

    // Validate input
    const { tenantId, file } = this.validateUploadInput(fields, files);

    // Generate unique asset ID
    const assetId = uuidv4();
    const now = new Date().toISOString();

    this.logger.info('UPLOAD_START', {
      fileName: file.filename,
      fileSize: file.content.length,
      contentType: file.contentType,
      tenantId: tenantId,
      assetId: assetId,
      sourceUrl: null,
      extractionMethod: 'direct'
    }, `Starting upload for ${file.filename}`);

    // Upload file to S3
    const uploadedFile = await this.uploadToS3(file, assetId, tenantId, correlationId);

    // Create initial document metadata
    const documentMetadata: DocumentMetadata = {
      tenant_id: tenantId,
      asset_id: assetId,
      file_name: file.filename,
      file_size: file.content.length,
      content_type: file.contentType,
      s3_bucket: uploadedFile.bucket,
      s3_key: uploadedFile.key,
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
    await this.saveDocumentMetadata(documentMetadata, correlationId);

    // Trigger text processing
    try {
      await this.triggerTextProcessing(file, assetId, uploadedFile.bucket, uploadedFile.key, correlationId);
      
      // Update status to PROCESSED
      await this.updateDocumentStatus(tenantId, assetId, 'PROCESSED', correlationId);
      documentMetadata.status = 'PROCESSED';
      
      this.logger.pipelineStage('TEXT_PROCESSING_PIPELINE_COMPLETE', {
        documentId: assetId,
        fileName: file.filename,
        status: 'PROCESSED'
      }, 'Text processing pipeline completed successfully');
      
    } catch (textProcessingError) {
      // Mark as FAILED if text processing fails
      const errorMessage = `Text processing failed: ${textProcessingError instanceof Error ? textProcessingError.message : 'Unknown error'}`;
      await this.updateDocumentStatus(tenantId, assetId, 'FAILED', correlationId, errorMessage);
      documentMetadata.status = 'FAILED';
      documentMetadata.error_message = errorMessage;
      
      throw textProcessingError;
    }

    const totalTime = Date.now() - startTime;

    this.logger.pipelineStage('UPLOAD_COMPLETE', {
      fileName: file.filename,
      documentId: assetId,
      totalDuration: totalTime,
      s3Location: `s3://${uploadedFile.bucket}/${uploadedFile.key}`,
      nextStep: 'COMPLETE'
    }, `Upload pipeline completed successfully`);

    this.logger.performance('UPLOAD_TOTAL', totalTime, {
      fileName: file.filename,
      fileSize: file.content.length,
      documentId: assetId
    });

    return {
      success: true,
      documentMetadata,
      processingTime: totalTime,
      uploadedFile
    };
  }
}
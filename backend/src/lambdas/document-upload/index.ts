import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { createResponse, createErrorResponse } from '../../utils/response.utils';

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
  gsi1_sk: string; // For time-based queries: created_at#asset_id
  gsi2_pk: string; // For status-based queries: tenant_id#status
  gsi2_sk: string; // For status-based queries: created_at#asset_id
}

const s3Client = new S3Client({ region: process.env.AWS_REGION });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

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
  tenantId: string
): Promise<{ bucket: string; key: string; }> {
  const bucket = process.env.DOCUMENTS_BUCKET_NAME!;
  const key = `documents/${tenantId}/${assetId}/${file.filename}`;

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

    return { bucket, key };
  } catch (error) {
    console.error('Error uploading to S3:', error);
    throw new Error('Failed to upload file to storage');
  }
}

async function saveDocumentMetadata(metadata: DocumentMetadata): Promise<void> {
  try {
    await dynamoClient.send(new PutCommand({
      TableName: process.env.DOCUMENTS_TABLE_NAME!,
      Item: metadata,
    }));
  } catch (error) {
    console.error('Error saving document metadata:', error);
    throw new Error('Failed to save document metadata');
  }
}

async function updateDocumentStatus(
  tenantId: string,
  assetId: string,
  status: DocumentMetadata['status'],
  errorMessage?: string
): Promise<void> {
  const now = new Date().toISOString();
  
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
  } catch (error) {
    console.error('Error updating document status:', error);
    throw new Error('Failed to update document status');
  }
}



export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();
  let assetId: string | undefined;
  let tenantId: string | undefined;

  try {
    console.log('Document upload request received');

    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, { message: 'CORS preflight successful' });
    }

    if (event.httpMethod !== 'POST') {
      return createResponse(405, { error: 'Method not allowed' });
    }

    // Validate content type
    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return createResponse(400, { error: 'Content-Type must be multipart/form-data' });
    }

    // Extract boundary
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      return createResponse(400, { error: 'Missing boundary in Content-Type header' });
    }

    const boundary = boundaryMatch[1];
    
    if (!event.body) {
      return createResponse(400, { error: 'Request body is required' });
    }

    // Parse multipart form data
    const { files, fields } = parseMultipartFormData(event.body, boundary);
    
    // Validate input
    const { tenantId: validatedTenantId, file } = validateInput(fields, files);
    tenantId = validatedTenantId;

    // Generate unique asset ID
    assetId = uuidv4();
    const now = new Date().toISOString();

    console.log(`Processing document upload: tenant=${tenantId}, asset=${assetId}, file=${file.filename}`);

    // Upload file to S3
    const { bucket, key } = await uploadToS3(file, assetId, tenantId);

    // Create initial document metadata
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
      gsi1_sk: `${now}#${assetId}`,
      gsi2_pk: `${tenantId}#UPLOADED`,
      gsi2_sk: `${now}#${assetId}`,
    };

    // Save metadata to DynamoDB
    await saveDocumentMetadata(documentMetadata);

    // Update status directly to PROCESSED (no text processing)
    await updateDocumentStatus(tenantId, assetId, 'PROCESSED');

    const totalTime = Date.now() - startTime;

    console.log(`Document upload completed successfully: ${file.filename} (${file.content.length} bytes)`);

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
      },
      processing_time: totalTime,
      message: `Document uploaded successfully.`,
    });

  } catch (error) {
    console.error('Document upload error:', error);
    
    // If we have tenant and asset IDs, try to update status to FAILED
    if (tenantId && assetId) {
      try {
        await updateDocumentStatus(tenantId, assetId, 'FAILED', error instanceof Error ? error.message : 'Unknown error');
      } catch (updateError) {
        console.error('Failed to update document status to FAILED:', updateError);
      }
    }

    return createErrorResponse(
      500,
      'Document upload failed',
      error instanceof Error ? error.message : 'Unknown error occurred',
      { processing_time: Date.now() - startTime }
    );
  }
};
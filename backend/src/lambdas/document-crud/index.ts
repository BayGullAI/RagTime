import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { 
  DynamoDBDocumentClient, 
  QueryCommand, 
  GetCommand, 
  DeleteCommand,
  ScanCommand 
} from '@aws-sdk/lib-dynamodb';
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

interface ListDocumentsRequest {
  tenant_id: string;
  limit?: number;
  next_token?: string;
  status?: 'UPLOADED' | 'PROCESSED' | 'FAILED';
  sort_by?: 'created_at' | 'file_name' | 'file_size';
  sort_order?: 'asc' | 'desc';
}

interface ListDocumentsResponse {
  documents: DocumentMetadata[];
  next_token?: string;
  total_count?: number;
}

const s3Client = new S3Client({ region: process.env.AWS_REGION });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));


async function listDocuments(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const tenantId = event.queryStringParameters?.tenant_id;
    if (!tenantId) {
      return createResponse(400, { error: 'tenant_id query parameter is required' });
    }

    const limit = Math.min(parseInt(event.queryStringParameters?.limit || '10'), 100);
    const nextToken = event.queryStringParameters?.next_token;
    const status = event.queryStringParameters?.status as 'UPLOADED' | 'PROCESSED' | 'FAILED';
    const sortBy = event.queryStringParameters?.sort_by as 'created_at' | 'file_name' | 'file_size' || 'created_at';
    const sortOrder = event.queryStringParameters?.sort_order as 'asc' | 'desc' || 'desc';

    console.log(`Listing documents for tenant: ${tenantId}, limit: ${limit}, status: ${status}`);

    let params: any = {
      TableName: process.env.DOCUMENTS_TABLE_NAME!,
      Limit: limit,
      ScanIndexForward: sortOrder === 'asc',
    };

    if (nextToken) {
      try {
        params.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, 'base64').toString());
      } catch (error) {
        return createResponse(400, { error: 'Invalid next_token' });
      }
    }

    let documents: DocumentMetadata[] = [];

    if (status) {
      // Query by status using GSI2
      params = {
        ...params,
        IndexName: 'GSI2',
        KeyConditionExpression: 'gsi2_pk = :pk',
        ExpressionAttributeValues: {
          ':pk': `${tenantId}#${status}`,
        },
      };

      const result = await dynamoClient.send(new QueryCommand(params));
      documents = result.Items as DocumentMetadata[] || [];
      
      const response: ListDocumentsResponse = {
        documents: documents,
        total_count: result.Count,
      };

      if (result.LastEvaluatedKey) {
        response.next_token = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
      }

      return createResponse(200, response);
    } else {
      // Query all documents for tenant using main table
      params = {
        ...params,
        FilterExpression: 'tenant_id = :tenant_id',
        ExpressionAttributeValues: {
          ':tenant_id': tenantId,
        },
      };

      const result = await dynamoClient.send(new ScanCommand(params));
      documents = result.Items as DocumentMetadata[] || [];

      // Sort documents based on sortBy parameter
      documents.sort((a, b) => {
        let aValue: any, bValue: any;
        
        switch (sortBy) {
          case 'file_name':
            aValue = a.file_name.toLowerCase();
            bValue = b.file_name.toLowerCase();
            break;
          case 'file_size':
            aValue = a.file_size;
            bValue = b.file_size;
            break;
          case 'created_at':
          default:
            aValue = new Date(a.created_at).getTime();
            bValue = new Date(b.created_at).getTime();
            break;
        }

        if (sortOrder === 'asc') {
          return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
        } else {
          return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
        }
      });

      const response: ListDocumentsResponse = {
        documents: documents,
        total_count: result.Count,
      };

      if (result.LastEvaluatedKey) {
        response.next_token = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
      }

      return createResponse(200, response);
    }
  } catch (error) {
    console.error('Error listing documents:', error);
    return createErrorResponse(
      500,
      'Internal server error',
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  }
}

async function getDocument(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const assetId = event.pathParameters?.asset_id;
    const tenantId = event.queryStringParameters?.tenant_id;

    if (!assetId) {
      return createResponse(400, { error: 'asset_id path parameter is required' });
    }

    if (!tenantId) {
      return createResponse(400, { error: 'tenant_id query parameter is required' });
    }

    console.log(`Getting document: tenant=${tenantId}, asset=${assetId}`);

    const result = await dynamoClient.send(new GetCommand({
      TableName: process.env.DOCUMENTS_TABLE_NAME!,
      Key: {
        tenant_id: tenantId,
        asset_id: assetId,
      },
    }));

    if (!result.Item) {
      return createResponse(404, { error: 'Document not found' });
    }

    const document = result.Item as DocumentMetadata;

    // Check if S3 object exists
    try {
      await s3Client.send(new HeadObjectCommand({
        Bucket: document.s3_bucket,
        Key: document.s3_key,
      }));
    } catch (s3Error: any) {
      if (s3Error.name === 'NotFound') {
        console.warn(`S3 object not found for document ${assetId}: ${document.s3_key}`);
        // Update document status to indicate S3 object is missing
        document.error_message = 'S3 object not found';
      }
    }

    return createResponse(200, {
      document: document,
    });
  } catch (error) {
    console.error('Error getting document:', error);
    return createErrorResponse(
      500,
      'Internal server error',
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  }
}

async function deleteDocument(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const assetId = event.pathParameters?.asset_id;
    const tenantId = event.queryStringParameters?.tenant_id;
    const softDelete = event.queryStringParameters?.soft_delete === 'true';

    if (!assetId) {
      return createResponse(400, { error: 'asset_id path parameter is required' });
    }

    if (!tenantId) {
      return createResponse(400, { error: 'tenant_id query parameter is required' });
    }

    console.log(`Deleting document: tenant=${tenantId}, asset=${assetId}, soft_delete=${softDelete}`);

    // First, get the document to ensure it exists and get S3 details
    const getResult = await dynamoClient.send(new GetCommand({
      TableName: process.env.DOCUMENTS_TABLE_NAME!,
      Key: {
        tenant_id: tenantId,
        asset_id: assetId,
      },
    }));

    if (!getResult.Item) {
      return createResponse(404, { error: 'Document not found' });
    }

    const document = getResult.Item as DocumentMetadata;

    if (softDelete) {
      // Soft delete: Update status to indicate deletion
      const updateParams = {
        TableName: process.env.DOCUMENTS_TABLE_NAME!,
        Key: {
          tenant_id: tenantId,
          asset_id: assetId,
        },
        UpdateExpression: 'SET #status = :status, updated_at = :updated_at, gsi2_pk = :gsi2_pk',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': 'DELETED',
          ':updated_at': new Date().toISOString(),
          ':gsi2_pk': `${tenantId}#DELETED`,
        },
      };

      await dynamoClient.send(new DeleteCommand(updateParams));

      return createResponse(200, {
        success: true,
        message: 'Document soft deleted successfully',
        document_id: assetId,
        deletion_type: 'soft',
      });
    } else {
      // Hard delete: Remove from S3 and DynamoDB
      const deletionResults = {
        s3_deleted: false,
        dynamodb_deleted: false,
        vector_cleanup: false, // TODO: Implement when vector DB is integrated
      };

      // Delete from S3
      try {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: document.s3_bucket,
          Key: document.s3_key,
        }));
        deletionResults.s3_deleted = true;
        console.log(`S3 object deleted: ${document.s3_key}`);
      } catch (s3Error: any) {
        console.error(`Error deleting S3 object: ${s3Error.message}`);
        if (s3Error.name !== 'NoSuchKey') {
          throw s3Error; // Re-throw if not a "not found" error
        }
      }

      // Delete from DynamoDB
      await dynamoClient.send(new DeleteCommand({
        TableName: process.env.DOCUMENTS_TABLE_NAME!,
        Key: {
          tenant_id: tenantId,
          asset_id: assetId,
        },
      }));
      deletionResults.dynamodb_deleted = true;
      console.log(`DynamoDB record deleted: ${assetId}`);

      // TODO: Delete vector embeddings from PostgreSQL/pgvector when implemented
      // This should clean up entries from the embeddings table

      return createResponse(200, {
        success: true,
        message: 'Document permanently deleted successfully',
        document_id: assetId,
        deletion_type: 'hard',
        cleanup_results: deletionResults,
      });
    }
  } catch (error) {
    console.error('Error deleting document:', error);
    return createErrorResponse(
      500,
      'Document deletion failed',
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Document CRUD request received:', {
      httpMethod: event.httpMethod,
      path: event.path,
      pathParameters: event.pathParameters,
      queryStringParameters: event.queryStringParameters,
    });

    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, { message: 'CORS preflight successful' });
    }

    const method = event.httpMethod;
    const pathParams = event.pathParameters;

    // Route requests based on HTTP method and path
    if (method === 'GET' && !pathParams?.asset_id) {
      // GET /documents - List documents
      return await listDocuments(event);
    } else if (method === 'GET' && pathParams?.asset_id) {
      // GET /documents/{asset_id} - Get specific document
      return await getDocument(event);
    } else if (method === 'DELETE' && pathParams?.asset_id) {
      // DELETE /documents/{asset_id} - Delete document
      return await deleteDocument(event);
    } else {
      return createResponse(405, { 
        error: 'Method not allowed',
        allowed_methods: ['GET', 'DELETE', 'OPTIONS']
      });
    }
  } catch (error) {
    console.error('Document CRUD handler error:', error);
    return createErrorResponse(
      500,
      'Internal server error',
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  }
};
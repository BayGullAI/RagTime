import { APIGatewayProxyEvent } from 'aws-lambda';

// Mock all external dependencies
jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/client-dynamodb');
jest.mock('@aws-sdk/lib-dynamodb');

const mockSend = jest.fn();
const mockS3Client = {
  send: mockSend,
};
const mockDynamoClient = {
  send: mockSend,
};

// Mock implementations
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => mockS3Client),
  DeleteObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => mockDynamoClient),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => mockDynamoClient),
  },
  QueryCommand: jest.fn(),
  GetCommand: jest.fn(),
  DeleteCommand: jest.fn(),
  ScanCommand: jest.fn(),
}));

describe('Document CRUD Lambda', () => {
  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Set up environment variables
    process.env.ENVIRONMENT = 'test';
    process.env.DOCUMENTS_TABLE_NAME = 'test-table';
    process.env.AWS_REGION = 'us-east-1';
  });

  describe('CORS and Method Validation', () => {
    it('should handle CORS preflight requests', async () => {
      const { handler } = await import('./index');
      
      const corsEvent: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'OPTIONS',
        path: '/documents',
      };

      const result = await handler(corsEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      expect(result.headers).toEqual(
        expect.objectContaining({
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        })
      );
    });

    it('should reject unsupported HTTP methods', async () => {
      const { handler } = await import('./index');
      
      const postEvent: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'POST',
        path: '/documents',
      };

      const result = await handler(postEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(405);
      expect(JSON.parse(result.body)).toEqual({
        error: 'Method not allowed',
        allowed_methods: ['GET', 'DELETE', 'OPTIONS']
      });
    });
  });

  describe('List Documents', () => {
    it('should require tenant_id query parameter', async () => {
      const { handler } = await import('./index');
      
      const listEvent: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'GET',
        path: '/documents',
        queryStringParameters: {},
      };

      const result = await handler(listEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        error: 'tenant_id query parameter is required'
      });
    });

    it('should list documents for a tenant', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          {
            tenant_id: 'test-tenant',
            asset_id: 'test-asset-1',
            file_name: 'document1.txt',
            status: 'PROCESSED',
            created_at: '2024-01-01T00:00:00Z',
          }
        ],
        Count: 1,
      });

      const { handler } = await import('./index');
      
      const listEvent: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'GET',
        path: '/documents',
        queryStringParameters: {
          tenant_id: 'test-tenant',
        },
      };

      const result = await handler(listEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const response = JSON.parse(result.body);
      expect(response.documents).toHaveLength(1);
      expect(response.documents[0].asset_id).toBe('test-asset-1');
    });

    it('should handle pagination with next_token', async () => {
      const nextTokenData = { tenant_id: 'test-tenant', asset_id: 'test-asset-2' };
      const nextToken = Buffer.from(JSON.stringify(nextTokenData)).toString('base64');

      mockSend.mockResolvedValueOnce({
        Items: [],
        Count: 0,
      });

      const { handler } = await import('./index');
      
      const listEvent: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'GET',
        path: '/documents',
        queryStringParameters: {
          tenant_id: 'test-tenant',
          next_token: nextToken,
        },
      };

      const result = await handler(listEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      expect(mockSend).toHaveBeenCalled();
    });

    it('should handle invalid next_token', async () => {
      const { handler } = await import('./index');
      
      const listEvent: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'GET',
        path: '/documents',
        queryStringParameters: {
          tenant_id: 'test-tenant',
          next_token: 'invalid-token',
        },
      };

      const result = await handler(listEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        error: 'Invalid next_token'
      });
    });
  });

  describe('Get Document', () => {
    it('should handle list documents when no asset_id provided', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [],
        Count: 0,
      });

      const { handler } = await import('./index');
      
      const getEvent: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'GET',
        path: '/documents',
        pathParameters: {},
        queryStringParameters: {
          tenant_id: 'test-tenant',
        },
      };

      const result = await handler(getEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200); // This will be handled as list documents
    });

    it('should require tenant_id query parameter for get', async () => {
      const { handler } = await import('./index');
      
      const getEvent: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'GET',
        path: '/documents/test-asset',
        pathParameters: {
          asset_id: 'test-asset',
        },
        queryStringParameters: {},
      };

      const result = await handler(getEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        error: 'tenant_id query parameter is required'
      });
    });

    it('should return document details when found', async () => {
      const mockDocument = {
        tenant_id: 'test-tenant',
        asset_id: 'test-asset',
        file_name: 'document.txt',
        s3_bucket: 'test-bucket',
        s3_key: 'test-key',
        status: 'PROCESSED',
      };

      mockSend
        .mockResolvedValueOnce({ Item: mockDocument }) // DynamoDB GetCommand
        .mockResolvedValueOnce({}); // S3 HeadObjectCommand

      const { handler } = await import('./index');
      
      const getEvent: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'GET',
        path: '/documents/test-asset',
        pathParameters: {
          asset_id: 'test-asset',
        },
        queryStringParameters: {
          tenant_id: 'test-tenant',
        },
      };

      const result = await handler(getEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const response = JSON.parse(result.body);
      expect(response.document.asset_id).toBe('test-asset');
    });

    it('should return 404 when document not found', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const { handler } = await import('./index');
      
      const getEvent: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'GET',
        path: '/documents/nonexistent',
        pathParameters: {
          asset_id: 'nonexistent',
        },
        queryStringParameters: {
          tenant_id: 'test-tenant',
        },
      };

      const result = await handler(getEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body)).toEqual({
        error: 'Document not found'
      });
    });
  });

  describe('Delete Document', () => {
    it('should require asset_id and tenant_id for deletion', async () => {
      const { handler } = await import('./index');
      
      const deleteEvent: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'DELETE',
        path: '/documents/test-asset',
        pathParameters: {
          asset_id: 'test-asset',
        },
        queryStringParameters: {},
      };

      const result = await handler(deleteEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        error: 'tenant_id query parameter is required'
      });
    });

    it('should perform hard delete by default', async () => {
      const mockDocument = {
        tenant_id: 'test-tenant',
        asset_id: 'test-asset',
        s3_bucket: 'test-bucket',
        s3_key: 'test-key',
      };

      mockSend
        .mockResolvedValueOnce({ Item: mockDocument }) // DynamoDB GetCommand
        .mockResolvedValueOnce({}) // S3 DeleteObjectCommand
        .mockResolvedValueOnce({}); // DynamoDB DeleteCommand

      const { handler } = await import('./index');
      
      const deleteEvent: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'DELETE',
        path: '/documents/test-asset',
        pathParameters: {
          asset_id: 'test-asset',
        },
        queryStringParameters: {
          tenant_id: 'test-tenant',
        },
      };

      const result = await handler(deleteEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const response = JSON.parse(result.body);
      expect(response.deletion_type).toBe('hard');
      expect(response.cleanup_results.s3_deleted).toBe(true);
      expect(response.cleanup_results.dynamodb_deleted).toBe(true);
    });

    it('should perform soft delete when requested', async () => {
      const mockDocument = {
        tenant_id: 'test-tenant',
        asset_id: 'test-asset',
      };

      mockSend.mockResolvedValueOnce({ Item: mockDocument });

      const { handler } = await import('./index');
      
      const deleteEvent: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'DELETE',
        path: '/documents/test-asset',
        pathParameters: {
          asset_id: 'test-asset',
        },
        queryStringParameters: {
          tenant_id: 'test-tenant',
          soft_delete: 'true',
        },
      };

      const result = await handler(deleteEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const response = JSON.parse(result.body);
      expect(response.deletion_type).toBe('soft');
    });

    it('should return 404 when trying to delete non-existent document', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const { handler } = await import('./index');
      
      const deleteEvent: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'DELETE',
        path: '/documents/nonexistent',
        pathParameters: {
          asset_id: 'nonexistent',
        },
        queryStringParameters: {
          tenant_id: 'test-tenant',
        },
      };

      const result = await handler(deleteEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body)).toEqual({
        error: 'Document not found'
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle DynamoDB errors gracefully', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB connection failed'));

      const { handler } = await import('./index');
      
      const listEvent: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'GET',
        path: '/documents',
        queryStringParameters: {
          tenant_id: 'test-tenant',
        },
      };

      const result = await handler(listEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({
        error: 'Internal server error',
        message: 'DynamoDB connection failed',
      });
    });
  });
});
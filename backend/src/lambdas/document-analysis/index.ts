import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createResponse } from '../../utils/response.utils';
import { initializeLogger } from '../../utils/structured-logger';
import { Pool } from 'pg';
import * as AWS from '@aws-sdk/client-secrets-manager';

interface EmbeddingData {
  total_embeddings: number;
  unique_chunks: number;
  avg_content_length: number;
  first_embedding?: string;
  last_embedding?: string;
  chunks?: Array<{
    chunk_index: number;
    content: string;
    created_at: string;
  }>;
}

interface PostgreSQLData {
  exists: boolean;
  original_filename?: string;
  content_type?: string;
  file_size?: number;
  total_chunks?: number;
  status?: string;
  error_message?: string;
  created_at?: string;
}

interface AnalysisResponse {
  postgresql?: PostgreSQLData;
  embeddings?: EmbeddingData;
}

let dbPool: Pool | null = null;

async function getDatabaseCredentials(): Promise<any> {
  const secretsClient = new AWS.SecretsManagerClient({});
  const secretName = process.env.DATABASE_SECRET_NAME!;
  
  try {
    const response = await secretsClient.send(
      new AWS.GetSecretValueCommand({ SecretId: secretName })
    );
    return JSON.parse(response.SecretString!);
  } catch (error: any) {
    throw new Error(`Failed to retrieve database credentials: ${error.message}`);
  }
}

async function getDbPool(): Promise<Pool> {
  if (!dbPool) {
    const credentials = await getDatabaseCredentials();
    
    dbPool = new Pool({
      host: process.env.DATABASE_CLUSTER_ENDPOINT,
      port: credentials.port || 5432,
      database: process.env.DATABASE_NAME || 'ragtime',
      user: credentials.username,
      password: credentials.password,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return dbPool;
}

async function getDocumentMetadata(assetId: string): Promise<PostgreSQLData> {
  const pool = await getDbPool();
  
  try {
    const query = `
      SELECT 
        original_filename,
        content_type,
        file_size,
        total_chunks,
        status,
        error_message,
        created_at
      FROM documents 
      WHERE asset_id = $1
    `;
    
    const result = await pool.query(query, [assetId]);
    
    if (result.rows.length === 0) {
      return { exists: false };
    }
    
    const row = result.rows[0];
    return {
      exists: true,
      original_filename: row.original_filename,
      content_type: row.content_type,
      file_size: row.file_size,
      total_chunks: row.total_chunks,
      status: row.status,
      error_message: row.error_message,
      created_at: row.created_at,
    };
  } catch (error: any) {
    throw new Error(`Failed to get document metadata for ${assetId}: ${error.message}`);
  }
}

async function getDocumentEmbeddings(assetId: string): Promise<EmbeddingData> {
  const pool = await getDbPool();
  
  try {
    // Get embedding statistics
    const statsQuery = `
      SELECT 
        COUNT(*) as total_embeddings,
        COUNT(DISTINCT chunk_index) as unique_chunks,
        AVG(LENGTH(content)) as avg_content_length,
        MIN(created_at) as first_embedding,
        MAX(created_at) as last_embedding
      FROM document_embeddings 
      WHERE asset_id = $1
    `;
    
    const statsResult = await pool.query(statsQuery, [assetId]);
    const stats = statsResult.rows[0];
    
    if (stats.total_embeddings === 0) {
      return {
        total_embeddings: 0,
        unique_chunks: 0,
        avg_content_length: 0,
      };
    }
    
    // Get chunk details (limit to 10 for display)
    const chunksQuery = `
      SELECT 
        chunk_index,
        content,
        created_at
      FROM document_embeddings 
      WHERE asset_id = $1
      ORDER BY chunk_index
      LIMIT 10
    `;
    
    const chunksResult = await pool.query(chunksQuery, [assetId]);
    
    return {
      total_embeddings: parseInt(stats.total_embeddings),
      unique_chunks: parseInt(stats.unique_chunks),
      avg_content_length: parseFloat(stats.avg_content_length) || 0,
      first_embedding: stats.first_embedding,
      last_embedding: stats.last_embedding,
      chunks: chunksResult.rows.map(row => ({
        chunk_index: row.chunk_index,
        content: row.content,
        created_at: row.created_at,
      })),
    };
  } catch (error: any) {
    throw new Error(`Failed to get document embeddings for ${assetId}: ${error.message}`);
  }
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  // Initialize logger with correlation ID
  const logger = initializeLogger(event, 'document-analysis');
  const correlationId = logger.getCorrelationIdForLambda();
  
  logger.info('handler', { 
    path: event.path,
    method: event.httpMethod,
    correlationId 
  }, 'Document analysis request received');

  try {
    const assetId = event.pathParameters?.asset_id;
    if (!assetId) {
      return createResponse(400, { error: 'Asset ID is required' });
    }

    const tenantId = event.queryStringParameters?.tenant_id;
    if (!tenantId) {
      return createResponse(400, { error: 'tenant_id parameter is required' });
    }

    // Get PostgreSQL document metadata
    const postgresqlData = await getDocumentMetadata(assetId);
    
    // Get embeddings data
    const embeddingsData = await getDocumentEmbeddings(assetId);
    
    const response: AnalysisResponse = {
      postgresql: postgresqlData,
      embeddings: embeddingsData,
    };

    logger.info('handler', { 
      assetId, 
      tenantId,
      hasPostgreSQLRecord: postgresqlData.exists,
      totalEmbeddings: embeddingsData.total_embeddings,
      correlationId 
    }, 'Document analysis completed');

    return createResponse(200, response);
    
  } catch (error: any) {
    logger.error('handler', { 
      error: error.message, 
      stack: error.stack,
      correlationId 
    }, 'Document analysis failed');
    return createResponse(500, { error: 'Internal server error' });
  }
};
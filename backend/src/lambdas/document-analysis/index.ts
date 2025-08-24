/**
 * Document Analysis Lambda Handler (Phase 4: Standardized error handling)
 * Updated to use standardized error handling patterns
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createResponse, createApplicationErrorResponse } from '../../utils/response.utils';
import { initializeLogger } from '../../utils/structured-logger';
import { CompositionRoot } from '../../container/composition-root';
import { ServiceTokens } from '../../container/service-container';
import { ErrorHandler } from '../../interfaces/error-handler.interface';
import { ValidationError, NotFoundError } from '../../utils/application-error';
import { createErrorContextFromEvent } from '../../utils/error-context';
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

async function getPostgreSQLPool(): Promise<Pool> {
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
  try {
    const pool = await getPostgreSQLPool();
    const result = await pool.query(
      'SELECT * FROM documents WHERE id = $1 LIMIT 1',
      [assetId]
    );
    
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
  try {
    const pool = await getPostgreSQLPool();
    
    // Get embedding statistics
    const statsQuery = `
      SELECT 
        COUNT(*) as total_embeddings,
        COUNT(DISTINCT chunk_index) as unique_chunks,
        AVG(LENGTH(content)) as avg_content_length,
        MIN(created_at) as first_embedding,
        MAX(created_at) as last_embedding
      FROM document_embeddings 
      WHERE document_id = $1
    `;
    
    const statsResult = await pool.query(statsQuery, [assetId]);
    const stats = statsResult.rows[0];
    
    // Get sample chunks (first 3)
    const chunksQuery = `
      SELECT chunk_index, content, created_at 
      FROM document_embeddings 
      WHERE document_id = $1 
      ORDER BY chunk_index 
      LIMIT 3
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
      const context = createErrorContextFromEvent(event, 'DOCUMENT_ANALYSIS_VALIDATION', correlationId);
      throw new ValidationError('Asset ID is required', context);
    }

    const tenantId = event.queryStringParameters?.tenant_id;
    if (!tenantId) {
      const context = createErrorContextFromEvent(event, 'DOCUMENT_ANALYSIS_VALIDATION', correlationId);
      throw new ValidationError('tenant_id parameter is required', context);
    }

    // Get PostgreSQL document metadata
    const postgresqlData = await getDocumentMetadata(assetId);
    
    // Check if document exists
    if (!postgresqlData.exists) {
      const context = createErrorContextFromEvent(event, 'DOCUMENT_ANALYSIS_NOT_FOUND', correlationId);
      throw new NotFoundError('document', assetId, context);
    }
    
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
    
  } catch (error) {
    // Use standardized error handling
    const context = createErrorContextFromEvent(event, 'DOCUMENT_ANALYSIS_PIPELINE', correlationId);
    
    const container = CompositionRoot.getContainer();
    const errorHandler = container.resolve<ErrorHandler>(ServiceTokens.ERROR_HANDLER);
    const applicationError = errorHandler.handleError(error as Error, context);

    // Return standardized error response
    return createApplicationErrorResponse(applicationError, true);
  }
};
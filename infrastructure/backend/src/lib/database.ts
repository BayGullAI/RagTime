import { SecretsManager } from 'aws-sdk';
import { Pool, Client, PoolClient } from 'pg';

const secretsManager = new SecretsManager();

interface DatabaseCredentials {
  username: string;
  password: string;
}

interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

// Global connection pool - reused across Lambda invocations
let connectionPool: Pool | null = null;

/**
 * Get database credentials from AWS Secrets Manager
 */
export async function getDatabaseCredentials(): Promise<DatabaseCredentials> {
  const secretName = process.env.DATABASE_SECRET_NAME;
  if (!secretName) {
    throw new Error('DATABASE_SECRET_NAME environment variable is required');
  }

  try {
    const result = await secretsManager.getSecretValue({ SecretId: secretName }).promise();
    if (!result.SecretString) {
      throw new Error('Secret string not found');
    }
    
    return JSON.parse(result.SecretString) as DatabaseCredentials;
  } catch (error) {
    console.error('Error retrieving database credentials:', error);
    throw error;
  }
}

/**
 * Create database configuration from environment and credentials
 */
export function createDatabaseConfig(credentials: DatabaseCredentials): DatabaseConfig {
  const endpoint = process.env.DATABASE_CLUSTER_ENDPOINT;
  const dbName = process.env.DATABASE_NAME;
  
  if (!endpoint || !dbName) {
    throw new Error('DATABASE_CLUSTER_ENDPOINT and DATABASE_NAME environment variables are required');
  }

  return {
    host: endpoint,
    port: 5432,
    database: dbName,
    username: credentials.username,
    password: credentials.password,
  };
}

/**
 * Get or create connection pool
 */
export async function getConnectionPool(): Promise<Pool> {
  if (!connectionPool) {
    console.log('Creating new database connection pool...');
    
    const credentials = await getDatabaseCredentials();
    const dbConfig = createDatabaseConfig(credentials);
    
    connectionPool = new Pool({
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      user: dbConfig.username,
      password: dbConfig.password,
      ssl: {
        rejectUnauthorized: false // Aurora requires SSL
      },
      // Connection pool settings
      min: 0,                    // Minimum connections in pool
      max: 10,                   // Maximum connections in pool
      idleTimeoutMillis: 30000,  // Close idle connections after 30 seconds
      connectionTimeoutMillis: 10000, // Wait 10 seconds for connection
      query_timeout: 30000,      // Query timeout 30 seconds
    });

    // Handle pool errors
    connectionPool.on('error', (err: any) => {
      console.error('Database pool error:', err);
    });

    console.log('Database connection pool created successfully');
  }
  
  return connectionPool;
}

/**
 * Get a database client from the pool
 */
export async function getClient(): Promise<PoolClient> {
  const pool = await getConnectionPool();
  return pool.connect();
}

/**
 * Execute a query with automatic client management
 */
export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const client = await getClient();
  try {
    const result = await client.query(text, params);
    return result.rows;
  } finally {
    client.release();
  }
}

/**
 * Execute a transaction with automatic client management
 */
export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Test database connection
 */
export async function testConnection(): Promise<void> {
  console.log('Testing database connection...');
  
  try {
    const result = await query('SELECT version()');
    console.log('Database connection successful. PostgreSQL version:', result[0]?.version);
  } catch (error) {
    console.error('Database connection failed:', error);
    throw error;
  }
}

/**
 * Close connection pool (useful for cleanup)
 */
export async function closePool(): Promise<void> {
  if (connectionPool) {
    console.log('Closing database connection pool...');
    await connectionPool.end();
    connectionPool = null;
    console.log('Database connection pool closed');
  }
}

/**
 * Vector database operations
 */
export class VectorDatabase {
  /**
   * Insert document embeddings
   */
  static async insertEmbeddings(documentId: string, chunks: Array<{
    chunkIndex: number;
    content: string;
    embedding: number[];
    metadata?: any;
  }>): Promise<void> {
    console.log(`Inserting ${chunks.length} embeddings for document ${documentId}`);
    
    await transaction(async (client) => {
      for (const chunk of chunks) {
        const embeddingVector = `[${chunk.embedding.join(',')}]`;
        
        await client.query(`
          INSERT INTO document_embeddings (
            document_id, chunk_index, content, embedding, metadata
          ) VALUES ($1, $2, $3, $4::vector, $5)
        `, [
          documentId,
          chunk.chunkIndex,
          chunk.content,
          embeddingVector,
          chunk.metadata ? JSON.stringify(chunk.metadata) : null
        ]);
      }
    });
    
    console.log(`Successfully inserted ${chunks.length} embeddings for document ${documentId}`);
  }

  /**
   * Search for similar documents using cosine similarity
   */
  static async similaritySearch(
    queryEmbedding: number[],
    limit: number = 10,
    threshold: number = 0.8
  ): Promise<Array<{
    id: number;
    documentId: string;
    chunkIndex: number;
    content: string;
    distance: number;
    metadata?: any;
  }>> {
    const embeddingVector = `[${queryEmbedding.join(',')}]`;
    
    const results = await query(`
      SELECT 
        id,
        document_id,
        chunk_index,
        content,
        embedding <=> $1::vector as distance,
        metadata
      FROM document_embeddings
      WHERE embedding <=> $1::vector < $2
      ORDER BY embedding <=> $1::vector
      LIMIT $3
    `, [embeddingVector, 1 - threshold, limit]);

    return results.map(row => ({
      id: row.id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      content: row.content,
      distance: parseFloat(row.distance),
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
  }

  /**
   * Delete all embeddings for a document
   */
  static async deleteDocument(documentId: string): Promise<number> {
    const result = await query(
      'DELETE FROM document_embeddings WHERE document_id = $1',
      [documentId]
    );
    
    console.log(`Deleted embeddings for document ${documentId}`);
    return result.length;
  }

  /**
   * Get document statistics
   */
  static async getDocumentStats(documentId: string): Promise<{
    chunkCount: number;
    avgEmbeddingSize: number;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    const results = await query(`
      SELECT 
        COUNT(*) as chunk_count,
        AVG(array_length(embedding::real[], 1)) as avg_embedding_size,
        MIN(created_at) as created_at,
        MAX(updated_at) as updated_at
      FROM document_embeddings
      WHERE document_id = $1
    `, [documentId]);

    const row = results[0];
    if (!row || row.chunk_count === '0') {
      return null;
    }

    return {
      chunkCount: parseInt(row.chunk_count),
      avgEmbeddingSize: parseFloat(row.avg_embedding_size || '0'),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  /**
   * List all documents with their metadata
   */
  static async listDocuments(): Promise<Array<{
    documentId: string;
    chunkCount: number;
    firstChunk: string;
    createdAt: Date;
  }>> {
    const results = await query(`
      SELECT 
        document_id,
        COUNT(*) as chunk_count,
        MIN(content) as first_chunk,
        MIN(created_at) as created_at
      FROM document_embeddings
      GROUP BY document_id
      ORDER BY MIN(created_at) DESC
    `);

    return results.map(row => ({
      documentId: row.document_id,
      chunkCount: parseInt(row.chunk_count),
      firstChunk: row.first_chunk?.substring(0, 100) || '',
      createdAt: new Date(row.created_at)
    }));
  }
}
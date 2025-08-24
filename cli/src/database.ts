import { Pool } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

interface DatabaseCredentials {
  username: string;
  password: string;
  host: string;
  port: number;
  dbname: string;
}

interface EmbeddingRow {
  id: number;
  document_id: string;
  chunk_index: number;
  content: string;
  metadata: any;
  created_at: string;
}

interface DocumentRow {
  id: string;
  original_filename: string;
  content_type: string;
  file_size: number;
  total_chunks: number;
  status: string;
  error_message?: string;
  metadata: any;
  created_at: string;
}

let pool: Pool | null = null;

async function getDatabaseCredentials(): Promise<DatabaseCredentials> {
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
  
  try {
    const result = await client.send(new GetSecretValueCommand({
      SecretId: 'ragtime-database-credentials-dev'
    }));
    
    if (result.SecretString) {
      return JSON.parse(result.SecretString);
    }
  } catch (error) {
    console.warn('Could not retrieve database credentials from Secrets Manager:', error);
  }
  
  // Fallback to environment variables
  return {
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || '',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    dbname: process.env.DB_NAME || 'ragtime'
  };
}

async function getPool(): Promise<Pool> {
  if (!pool) {
    const credentials = await getDatabaseCredentials();
    pool = new Pool({
      user: credentials.username,
      password: credentials.password,
      host: credentials.host,
      port: credentials.port,
      database: credentials.dbname,
      ssl: credentials.host !== 'localhost' ? { rejectUnauthorized: false } : false
    });
  }
  return pool;
}

export async function getDocumentEmbeddings(documentId: string): Promise<EmbeddingRow[]> {
  const pool = await getPool();
  const result = await pool.query(
    'SELECT id, document_id, chunk_index, content, metadata, created_at FROM document_embeddings WHERE document_id = $1 ORDER BY chunk_index',
    [documentId]
  );
  return result.rows;
}

export async function getDocumentMetadata(documentId: string): Promise<DocumentRow | null> {
  const pool = await getPool();
  const result = await pool.query(
    'SELECT * FROM documents WHERE id = $1',
    [documentId]
  );
  return result.rows[0] || null;
}

export async function getEmbeddingStats(documentId: string): Promise<{
  totalEmbeddings: number;
  uniqueChunks: number;
  avgContentLength: number;
  firstEmbedding: string | null;
  lastEmbedding: string | null;
}> {
  const pool = await getPool();
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_embeddings,
      COUNT(DISTINCT chunk_index) as unique_chunks,
      AVG(LENGTH(content)) as avg_content_length,
      MIN(created_at) as first_embedding,
      MAX(created_at) as last_embedding
    FROM document_embeddings 
    WHERE document_id = $1
  `, [documentId]);
  
  const row = result.rows[0];
  return {
    totalEmbeddings: parseInt(row.total_embeddings || '0'),
    uniqueChunks: parseInt(row.unique_chunks || '0'),
    avgContentLength: parseFloat(row.avg_content_length || '0'),
    firstEmbedding: row.first_embedding,
    lastEmbedding: row.last_embedding
  };
}

export async function closeDatabaseConnection(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
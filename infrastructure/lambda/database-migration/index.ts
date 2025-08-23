import { Handler } from 'aws-lambda';
import { Client } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as url from 'url';

interface DatabaseCredentials {
  username: string;
  password: string;
}

interface CloudFormationEvent {
  RequestType?: 'Create' | 'Update' | 'Delete';
  ResponseURL?: string;
  StackId?: string;
  RequestId?: string;
  LogicalResourceId?: string;
  PhysicalResourceId?: string;
  ResourceProperties?: any;
}

const sendResponse = async (
  event: CloudFormationEvent,
  status: 'SUCCESS' | 'FAILED',
  data?: any,
  physicalResourceId?: string,
  reason?: string
): Promise<void> => {
  // Only send CloudFormation response if this is a CloudFormation custom resource event
  if (!event.ResponseURL) {
    console.log('Not a CloudFormation custom resource - skipping response');
    return;
  }

  const responseBody = JSON.stringify({
    Status: status,
    Reason: reason || 'CloudFormation custom resource response',
    PhysicalResourceId: physicalResourceId || 'database-migration-' + Date.now(),
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data || {}
  });

  const parsedUrl = url.parse(event.ResponseURL);
  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.path,
    method: 'PUT',
    headers: {
      'content-type': '',
      'content-length': responseBody.length
    }
  };

  return new Promise<void>((resolve, reject) => {
    const request = https.request(options, (response) => {
      console.log('CloudFormation response status:', response.statusCode);
      resolve();
    });

    request.on('error', (error) => {
      console.error('CloudFormation response error:', error);
      reject(error);
    });

    request.write(responseBody);
    request.end();
  });
};

export const handler: Handler = async (event: CloudFormationEvent) => {
  console.log('Starting database schema initialization...');
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Handle CloudFormation Delete requests (skip for trigger invocations)
    if (event.RequestType === 'Delete') {
      console.log('CloudFormation Delete request - no action needed for database schema');
      await sendResponse(event, 'SUCCESS', { message: 'Delete completed successfully' });
      return;
    }

    // Handle Create and Update requests
    const secretsClient = new SecretsManagerClient({ 
      region: process.env.AWS_REGION || 'us-east-1'
    });
    
    // Get database credentials from Secrets Manager
    console.log('Retrieving database credentials...');
    const secretResponse = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: process.env.DATABASE_SECRET_NAME })
    );
    
    if (!secretResponse.SecretString) {
      throw new Error('No secret string found in Secrets Manager response');
    }
    
    const credentials: DatabaseCredentials = JSON.parse(secretResponse.SecretString);
    console.log('Database credentials retrieved successfully');
    
    // Connect to PostgreSQL with retry logic (Aurora instances take time to be ready)
    console.log('Connecting to PostgreSQL cluster...');
    let client: Client | null = null;
    let connectionAttempts = 0;
    const maxAttempts = 10; // Increased for Aurora startup time
    
    while (connectionAttempts < maxAttempts) {
      try {
        client = new Client({
          host: process.env.DATABASE_CLUSTER_ENDPOINT,
          port: 5432,
          database: process.env.DATABASE_NAME || 'ragtime', // Use env var
          user: credentials.username,
          password: credentials.password,
          ssl: { rejectUnauthorized: false },
          connectionTimeoutMillis: 45000, // Increased timeout
          query_timeout: 120000, // Increased query timeout
        });
        
        await client.connect();
        console.log('Connected to database successfully');
        
        // Test connection with simple query
        await client.query('SELECT 1');
        console.log('Database connection verified');
        break;
        
      } catch (connError: any) {
        connectionAttempts++;
        console.warn(`Connection attempt ${connectionAttempts}/${maxAttempts} failed:`, connError);
        
        if (connectionAttempts >= maxAttempts) {
          throw new Error(`Failed to connect to database after ${maxAttempts} attempts: ${connError?.message || String(connError)}`);
        }
        
        // Longer wait for Aurora Serverless V2 scale-up (up to 30 seconds for first connection)
        const waitTime = Math.min(Math.pow(2, connectionAttempts) * 1000, 30000);
        console.log(`Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    if (!client) {
      throw new Error('Failed to establish database connection after retries');
    }
    
    // Check if pgvector extension is available before installation
    console.log('Checking pgvector extension availability...');
    const extensionCheck = await client.query(`
      SELECT name FROM pg_available_extensions WHERE name = 'vector'
    `);
    
    if (extensionCheck.rows.length === 0) {
      throw new Error('pgvector extension is not available in this Aurora PostgreSQL version');
    }
    console.log('pgvector extension is available');

    // Download migration SQL from S3 with fallback to embedded SQL
    let migrationSQL: string;
    
    try {
      console.log('Downloading SQL file from S3...');
      
      // Initialize S3 client
      const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
      
      // Download SQL file from S3
      const response = await s3Client.send(new GetObjectCommand({
        Bucket: process.env.SQL_ASSET_BUCKET,
        Key: process.env.SQL_ASSET_KEY,
      }));
      
      if (!response.Body) {
        throw new Error('No SQL file content received from S3');
      }
      
      migrationSQL = await response.Body.transformToString();
      console.log('Migration SQL downloaded successfully from S3, length:', migrationSQL.length);
      
    } catch (s3Error) {
      console.error('Failed to download migration SQL file from S3:', s3Error);
      
      // Fallback: embedded SQL as string (as backup solution)
      console.log('Using embedded SQL as fallback...');
      migrationSQL = `
-- Migration: 001_initial_pgvector_schema (embedded)
-- Description: Create pgvector extension and initial schema for vector embeddings

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create document_embeddings table for storing vector embeddings
CREATE TABLE IF NOT EXISTS document_embeddings (
    id SERIAL PRIMARY KEY,
    document_id VARCHAR(255) NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL,
    embedding VECTOR(1536) NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for efficient vector similarity search
-- IVFFlat index for cosine similarity search (good for most use cases)
CREATE INDEX IF NOT EXISTS document_embeddings_embedding_cosine_idx 
    ON document_embeddings USING ivfflat (embedding vector_cosine_ops) 
    WITH (lists = 100);

-- Index for filtering by document_id
CREATE INDEX IF NOT EXISTS document_embeddings_document_id_idx 
    ON document_embeddings (document_id);

-- Index for filtering by document_id and chunk_index
CREATE INDEX IF NOT EXISTS document_embeddings_document_chunk_idx 
    ON document_embeddings (document_id, chunk_index);

-- Index for created_at for time-based queries
CREATE INDEX IF NOT EXISTS document_embeddings_created_at_idx 
    ON document_embeddings (created_at);

-- Create documents table for document metadata
CREATE TABLE IF NOT EXISTS documents (
    id VARCHAR(255) PRIMARY KEY,
    original_filename VARCHAR(512) NOT NULL,
    content_type VARCHAR(100),
    file_size INTEGER,
    total_chunks INTEGER DEFAULT 0,
    status VARCHAR(50) DEFAULT 'processing',
    error_message TEXT,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for status filtering
CREATE INDEX IF NOT EXISTS documents_status_idx ON documents (status);

-- Index for created_at
CREATE INDEX IF NOT EXISTS documents_created_at_idx ON documents (created_at);

-- Create migration tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    description TEXT
);

-- Record this migration
INSERT INTO schema_migrations (version, description) 
VALUES ('001_initial_pgvector_schema', 'Create pgvector extension and initial schema for vector embeddings')
ON CONFLICT (version) DO NOTHING;

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE 'plpgsql';

-- Create triggers to automatically update updated_at
DROP TRIGGER IF EXISTS update_document_embeddings_updated_at ON document_embeddings;
CREATE TRIGGER update_document_embeddings_updated_at
    BEFORE UPDATE ON document_embeddings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_documents_updated_at ON documents;
CREATE TRIGGER update_documents_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
      `;
      console.log('Fallback SQL embedded, length:', migrationSQL.length);
    }
    
    // Execute migration SQL
    console.log('Executing database migration...');
    await client.query(migrationSQL);
    console.log('Database schema initialized successfully');
    
    // Verify that tables were created
    const tableCheck = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('document_embeddings', 'documents', 'schema_migrations')
    `);
    console.log('Created tables:', tableCheck.rows.map(row => row.table_name));
    
    // Verify pgvector extension is installed
    const extensionVerify = await client.query(`
      SELECT name, default_version, installed_version
      FROM pg_available_extensions 
      WHERE name = 'vector'
    `);
    console.log('pgvector extension status:', extensionVerify.rows);
    
    // Verify specific table structures
    const embeddingsTableCheck = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
      AND table_name = 'document_embeddings'
    `);
    console.log('document_embeddings table columns:', embeddingsTableCheck.rows.length);
    
    // Check migration tracking
    const migrationCheck = await client.query(`
      SELECT version, applied_at, description
      FROM schema_migrations 
      WHERE version = '001_initial_pgvector_schema'
    `);
    console.log('Migration tracking:', migrationCheck.rows);
    
    await client.end();
    console.log('Database connection closed');
    
    // Send success response to CloudFormation
    await sendResponse(event, 'SUCCESS', {
      message: 'Database schema initialized successfully',
      tablesCreated: tableCheck.rows.map(row => row.table_name),
      migrationVersion: '001_initial_pgvector_schema',
      pgvectorExtension: extensionVerify.rows[0] || null,
      embeddingsTableColumns: embeddingsTableCheck.rows.length,
      migrationTracking: migrationCheck.rows[0] || null,
      sqlSource: migrationSQL.includes('embedded') ? 'embedded' : 's3'
    });
    
  } catch (error) {
    console.error('Database initialization failed:', error);
    
    // Send failure response to CloudFormation
    try {
      await sendResponse(
        event, 
        'FAILED', 
        {},
        undefined,
        `Database migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } catch (responseError) {
      console.error('Failed to send CloudFormation response:', responseError);
    }
    
    // Also throw the original error for Lambda logs
    throw error;
  }
};
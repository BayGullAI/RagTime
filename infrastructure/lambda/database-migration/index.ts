import { Handler } from 'aws-lambda';
import { Client } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
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

interface Migration {
  version: string;
  filename: string;
  content: string;
}

// No embedded migrations needed - all migrations are now read from SQL files

/**
 * Get list of migrations from S3 asset system
 */
async function getMigrations(): Promise<Migration[]> {
  // All migrations must come from S3 - no local copies exist
  if (!process.env.MIGRATIONS_ASSET_BUCKET || !process.env.MIGRATIONS_ASSET_KEY) {
    throw new Error('Migration S3 asset environment variables not configured');
  }

  try {
    const s3Migrations = await getMigrationsFromS3();
    console.log(`Loaded ${s3Migrations.length} migrations from S3 asset system`);
    return s3Migrations;
  } catch (error) {
    console.error('Failed to load migrations from S3:', error);
    throw new Error(`Migration loading failed: ${error}`);
  }
}

/**
 * Get migrations from new S3 asset system
 */
async function getMigrationsFromS3(): Promise<Migration[]> {
  const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
  
  console.log('Listing migration files from S3...');
  
  // List all objects in the migrations asset
  const listResponse = await s3Client.send(new ListObjectsV2Command({
    Bucket: process.env.MIGRATIONS_ASSET_BUCKET,
    Prefix: process.env.MIGRATIONS_ASSET_KEY || '',
  }));
  
  if (!listResponse.Contents) {
    throw new Error('No migration files found in S3');
  }
  
  // Filter for .sql files and sort by filename (which contains version)
  const sqlFiles = listResponse.Contents
    .filter(obj => obj.Key?.endsWith('.sql'))
    .sort((a, b) => (a.Key || '').localeCompare(b.Key || ''));
  
  console.log('Found migration files:', sqlFiles.map(f => f.Key));
  
  // Download each migration file
  const migrations: Migration[] = [];
  
  for (const file of sqlFiles) {
    if (!file.Key) continue;
    
    console.log(`Downloading migration: ${file.Key}`);
    
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: process.env.MIGRATIONS_ASSET_BUCKET,
      Key: file.Key,
    }));
    
    if (!response.Body) {
      console.warn(`No content found for migration: ${file.Key}`);
      continue;
    }
    
    const content = await response.Body.transformToString();
    const filename = path.basename(file.Key);
    const version = filename.split('_')[0]; // Extract version from filename like "001_name.sql"
    
    migrations.push({
      version,
      filename,
      content,
    });
  }
  
  return migrations;
}

/**
 * Check which migrations have already been applied
 */
async function getAppliedMigrations(client: Client): Promise<Set<string>> {
  try {
    const result = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    return new Set(result.rows.map(row => row.version));
  } catch (error: any) {
    // If schema_migrations table doesn't exist, no migrations have been applied
    if (error.code === '42P01') { // relation does not exist
      console.log('schema_migrations table does not exist yet - no migrations applied');
      return new Set();
    }
    throw error;
  }
}

/**
 * Handle schema deletion for CloudFormation Delete events
 */
async function handleSchemaDelete(event: CloudFormationEvent): Promise<void> {
  try {
    // Get database credentials
    const secretsClient = new SecretsManagerClient({ 
      region: process.env.AWS_REGION || 'us-east-1'
    });
    
    console.log('Retrieving database credentials for cleanup...');
    const secretResponse = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: process.env.DATABASE_SECRET_NAME })
    );
    
    if (!secretResponse.SecretString) {
      throw new Error('No secret string found in Secrets Manager response');
    }
    
    const credentials: DatabaseCredentials = JSON.parse(secretResponse.SecretString);
    
    // Connect to PostgreSQL
    const client = new Client({
      host: process.env.DATABASE_CLUSTER_ENDPOINT,
      port: 5432,
      database: process.env.DATABASE_NAME || 'ragtime',
      user: credentials.username,
      password: credentials.password,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 30000,
    });
    
    await client.connect();
    console.log('Connected to database for cleanup');
    
    // Drop tables in reverse dependency order
    const dropStatements = [
      'DROP TABLE IF EXISTS document_embeddings CASCADE;',
      'DROP TABLE IF EXISTS documents CASCADE;', 
      'DROP TABLE IF EXISTS schema_migrations CASCADE;',
      'DROP EXTENSION IF EXISTS vector CASCADE;'
    ];
    
    for (const statement of dropStatements) {
      try {
        console.log(`Executing: ${statement}`);
        await client.query(statement);
      } catch (error) {
        console.warn(`Warning during cleanup: ${error}`);
        // Continue with other cleanup steps
      }
    }
    
    await client.end();
    console.log('Database cleanup completed');
    
    await sendResponse(event, 'SUCCESS', { 
      message: 'Database schema deleted successfully',
      tablesDropped: ['document_embeddings', 'documents', 'schema_migrations'],
      extensionsDropped: ['vector']
    });
    
  } catch (error) {
    console.error('Database cleanup failed:', error);
    await sendResponse(
      event, 
      'FAILED', 
      {},
      undefined,
      `Database cleanup failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    throw error;
  }
}

/**
 * Run all pending migrations in sequence
 */
async function runMigrations(client: Client): Promise<void> {
  console.log('Starting migration runner...');
  
  // Get all available migrations
  const migrations = await getMigrations();
  console.log(`Found ${migrations.length} migration files`);
  
  // Get already applied migrations
  const appliedMigrations = await getAppliedMigrations(client);
  console.log(`Found ${appliedMigrations.size} already applied migrations:`, Array.from(appliedMigrations));
  
  // Filter to only pending migrations
  const pendingMigrations = migrations.filter(m => !appliedMigrations.has(m.version));
  console.log(`Found ${pendingMigrations.length} pending migrations:`, pendingMigrations.map(m => m.filename));
  
  if (pendingMigrations.length === 0) {
    console.log('No pending migrations to run');
    return;
  }
  
  // Run each pending migration in sequence
  for (const migration of pendingMigrations) {
    console.log(`Running migration ${migration.version}: ${migration.filename}`);
    
    try {
      // Begin transaction for this migration
      await client.query('BEGIN');
      
      // Execute the migration SQL
      await client.query(migration.content);
      
      // Record that this migration has been applied
      await client.query(
        'INSERT INTO schema_migrations (version, description) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
        [migration.version, migration.filename]
      );
      
      // Commit the transaction
      await client.query('COMMIT');
      
      console.log(`✅ Successfully applied migration ${migration.version}: ${migration.filename}`);
      
    } catch (error) {
      // Rollback on error
      await client.query('ROLLBACK');
      console.error(`❌ Failed to apply migration ${migration.version}:`, error);
      throw new Error(`Migration ${migration.version} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  console.log('All pending migrations completed successfully');
}

export const handler: Handler = async (event: CloudFormationEvent) => {
  console.log('Starting database schema initialization... (Phase 2: DI system complete)');
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Handle CloudFormation Delete requests
    if (event.RequestType === 'Delete') {
      console.log('CloudFormation Delete request - cleaning up database schema');
      await handleSchemaDelete(event);
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

    // Run migrations in sequence
    await runMigrations(client);
    console.log('All database migrations completed successfully');
    
    // Basic verification that key tables were created
    const tableCheck = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('document_embeddings', 'documents', 'schema_migrations')
    `);
    console.log('Created tables:', tableCheck.rows.map(row => row.table_name));
    
    // Get final migration state for reporting before closing connection
    const finalAppliedMigrations = await getAppliedMigrations(client);
    
    await client.end();
    console.log('Database connection closed');
    
    // Send success response to CloudFormation
    await sendResponse(event, 'SUCCESS', {
      message: 'Database schema initialized successfully',
      tablesCreated: tableCheck.rows.map(row => row.table_name),
      appliedMigrations: Array.from(finalAppliedMigrations).sort(),
      totalMigrations: finalAppliedMigrations.size,
      migrationSource: 's3'
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
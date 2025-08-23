/**
 * Database Validation Canary for RagTime Correlation Tracking Infrastructure
 * 
 * This canary validates that the correlation tracking schema has been properly applied:
 * - Verifies correlation tracking fields exist in documents and document_embeddings tables
 * - Validates indexes for correlation-based queries are present
 * - Tests basic database connectivity and schema integrity
 * - Provides structured logging for CloudWatch monitoring
 */

import { Handler } from 'aws-lambda';
import { Client } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

interface DatabaseCredentials {
  username: string;
  password: string;
}

interface CanaryResult {
  success: boolean;
  checks: CanaryCheck[];
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
  timestamp: string;
  correlationId: string;
}

interface CanaryCheck {
  name: string;
  description: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  details?: string;
  error?: string;
  duration?: number;
}

/**
 * Generate a canary-specific correlation ID for tracking
 */
function generateCanaryCorrelationId(): string {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14);
  const randomId = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `CANARY-${timestamp}-${randomId}`;
}

/**
 * Create and connect to database client
 */
async function createDatabaseClient(): Promise<Client> {
  const secretsClient = new SecretsManagerClient({ 
    region: process.env.AWS_REGION || 'us-east-1'
  });
  
  // Get database credentials from Secrets Manager
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
    query_timeout: 60000,
  });
  
  await client.connect();
  return client;
}

/**
 * Validate that required tables exist
 */
async function validateTablesExist(client: Client): Promise<CanaryCheck> {
  const startTime = Date.now();
  
  try {
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('documents', 'document_embeddings', 'schema_migrations')
      ORDER BY table_name
    `);
    
    const existingTables = result.rows.map(row => row.table_name);
    const requiredTables = ['documents', 'document_embeddings', 'schema_migrations'];
    const missingTables = requiredTables.filter(table => !existingTables.includes(table));
    
    if (missingTables.length > 0) {
      return {
        name: 'tables_exist',
        description: 'Verify core tables exist',
        status: 'FAIL',
        error: `Missing required tables: ${missingTables.join(', ')}`,
        details: `Found tables: ${existingTables.join(', ')}`,
        duration: Date.now() - startTime
      };
    }
    
    return {
      name: 'tables_exist',
      description: 'Verify core tables exist',
      status: 'PASS',
      details: `All required tables found: ${existingTables.join(', ')}`,
      duration: Date.now() - startTime
    };
    
  } catch (error) {
    return {
      name: 'tables_exist',
      description: 'Verify core tables exist',
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime
    };
  }
}

/**
 * Validate correlation tracking fields exist in documents table
 */
async function validateDocumentsCorrelationFields(client: Client): Promise<CanaryCheck> {
  const startTime = Date.now();
  
  try {
    const result = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
      AND table_name = 'documents'
      AND column_name IN ('correlation_id', 'source_url', 'extraction_method', 'word_count', 'character_count', 'processing_duration')
      ORDER BY column_name
    `);
    
    const existingColumns = result.rows.map(row => row.column_name);
    const requiredColumns = ['correlation_id', 'source_url', 'extraction_method', 'word_count', 'character_count', 'processing_duration'];
    const missingColumns = requiredColumns.filter(col => !existingColumns.includes(col));
    
    if (missingColumns.length > 0) {
      return {
        name: 'documents_correlation_fields',
        description: 'Verify correlation tracking fields in documents table',
        status: 'FAIL',
        error: `Missing correlation fields in documents table: ${missingColumns.join(', ')}`,
        details: `Found fields: ${existingColumns.join(', ')}`,
        duration: Date.now() - startTime
      };
    }
    
    return {
      name: 'documents_correlation_fields',
      description: 'Verify correlation tracking fields in documents table',
      status: 'PASS',
      details: `All correlation tracking fields found: ${existingColumns.join(', ')}`,
      duration: Date.now() - startTime
    };
    
  } catch (error) {
    return {
      name: 'documents_correlation_fields',
      description: 'Verify correlation tracking fields in documents table',
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime
    };
  }
}

/**
 * Validate correlation tracking fields exist in document_embeddings table
 */
async function validateEmbeddingsCorrelationFields(client: Client): Promise<CanaryCheck> {
  const startTime = Date.now();
  
  try {
    const result = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
      AND table_name = 'document_embeddings'
      AND column_name IN ('correlation_id', 'processing_stage', 'chunk_word_count', 'embedding_model', 'embedding_duration')
      ORDER BY column_name
    `);
    
    const existingColumns = result.rows.map(row => row.column_name);
    const requiredColumns = ['correlation_id', 'processing_stage', 'chunk_word_count', 'embedding_model', 'embedding_duration'];
    const missingColumns = requiredColumns.filter(col => !existingColumns.includes(col));
    
    if (missingColumns.length > 0) {
      return {
        name: 'embeddings_correlation_fields',
        description: 'Verify correlation tracking fields in document_embeddings table',
        status: 'FAIL',
        error: `Missing correlation fields in document_embeddings table: ${missingColumns.join(', ')}`,
        details: `Found fields: ${existingColumns.join(', ')}`,
        duration: Date.now() - startTime
      };
    }
    
    return {
      name: 'embeddings_correlation_fields',
      description: 'Verify correlation tracking fields in document_embeddings table',
      status: 'PASS',
      details: `All correlation tracking fields found: ${existingColumns.join(', ')}`,
      duration: Date.now() - startTime
    };
    
  } catch (error) {
    return {
      name: 'embeddings_correlation_fields',
      description: 'Verify correlation tracking fields in document_embeddings table',
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime
    };
  }
}

/**
 * Validate correlation tracking indexes exist
 */
async function validateCorrelationIndexes(client: Client): Promise<CanaryCheck> {
  const startTime = Date.now();
  
  try {
    const result = await client.query(`
      SELECT 
        schemaname,
        tablename,
        indexname,
        indexdef
      FROM pg_indexes 
      WHERE schemaname = 'public'
      AND (
        indexname LIKE '%correlation%' 
        OR indexname IN ('documents_correlation_id_idx', 'document_embeddings_correlation_id_idx', 'document_embeddings_processing_stage_idx')
      )
      ORDER BY tablename, indexname
    `);
    
    const existingIndexes = result.rows.map(row => row.indexname);
    const requiredIndexes = [
      'documents_correlation_id_idx',
      'document_embeddings_correlation_id_idx', 
      'document_embeddings_processing_stage_idx'
    ];
    
    const missingIndexes = requiredIndexes.filter(idx => !existingIndexes.includes(idx));
    
    if (missingIndexes.length > 0) {
      return {
        name: 'correlation_indexes',
        description: 'Verify correlation tracking indexes exist',
        status: 'FAIL',
        error: `Missing correlation indexes: ${missingIndexes.join(', ')}`,
        details: `Found indexes: ${existingIndexes.join(', ')}`,
        duration: Date.now() - startTime
      };
    }
    
    return {
      name: 'correlation_indexes',
      description: 'Verify correlation tracking indexes exist',
      status: 'PASS',
      details: `All correlation tracking indexes found: ${existingIndexes.join(', ')}`,
      duration: Date.now() - startTime
    };
    
  } catch (error) {
    return {
      name: 'correlation_indexes',
      description: 'Verify correlation tracking indexes exist',
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime
    };
  }
}

/**
 * Validate schema migrations have been applied
 */
async function validateMigrationsApplied(client: Client): Promise<CanaryCheck> {
  const startTime = Date.now();
  
  try {
    const result = await client.query(`
      SELECT version, description, applied_at
      FROM schema_migrations 
      ORDER BY version
    `);
    
    const appliedMigrations = result.rows;
    const requiredMigrations = ['001', '002']; // Initial schema + correlation tracking
    const appliedVersions = appliedMigrations.map(row => row.version);
    
    // Handle both version formats: "001" or "001_initial_pgvector_schema"
    const normalizedAppliedVersions = appliedVersions.map(v => v.split('_')[0]);
    const missingMigrations = requiredMigrations.filter(version => !normalizedAppliedVersions.includes(version));
    
    if (missingMigrations.length > 0) {
      return {
        name: 'migrations_applied',
        description: 'Verify required migrations have been applied',
        status: 'FAIL',
        error: `Missing migrations: ${missingMigrations.join(', ')}`,
        details: `Applied migrations: ${appliedVersions.join(', ')}`,
        duration: Date.now() - startTime
      };
    }
    
    return {
      name: 'migrations_applied',
      description: 'Verify required migrations have been applied',
      status: 'PASS',
      details: `All required migrations applied: ${appliedVersions.join(', ')} (${appliedMigrations.length} total)`,
      duration: Date.now() - startTime
    };
    
  } catch (error) {
    return {
      name: 'migrations_applied',
      description: 'Verify required migrations have been applied',
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime
    };
  }
}

/**
 * Test basic database connectivity and vector extension
 */
async function validateBasicConnectivity(client: Client): Promise<CanaryCheck> {
  const startTime = Date.now();
  
  try {
    // Test basic connectivity
    await client.query('SELECT 1');
    
    // Test vector extension is available
    const vectorCheck = await client.query(`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `);
    
    if (vectorCheck.rows.length === 0) {
      return {
        name: 'basic_connectivity',
        description: 'Test database connectivity and vector extension',
        status: 'FAIL',
        error: 'Vector extension not installed',
        duration: Date.now() - startTime
      };
    }
    
    return {
      name: 'basic_connectivity',
      description: 'Test database connectivity and vector extension',
      status: 'PASS',
      details: 'Database connection and vector extension verified',
      duration: Date.now() - startTime
    };
    
  } catch (error) {
    return {
      name: 'basic_connectivity',
      description: 'Test database connectivity and vector extension',
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime
    };
  }
}

export const handler: Handler = async (event) => {
  const correlationId = generateCanaryCorrelationId();
  const startTime = Date.now();
  
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'INFO',
    correlationId,
    service: 'database-validation-canary',
    operation: 'CANARY_START',
    data: { event: event },
    message: 'Starting database validation canary'
  }));
  
  let client: Client | null = null;
  const checks: CanaryCheck[] = [];
  
  try {
    // Create database connection
    client = await createDatabaseClient();
    
    // Run all validation checks
    checks.push(await validateBasicConnectivity(client));
    checks.push(await validateTablesExist(client));
    checks.push(await validateMigrationsApplied(client));
    checks.push(await validateDocumentsCorrelationFields(client));
    checks.push(await validateEmbeddingsCorrelationFields(client));
    checks.push(await validateCorrelationIndexes(client));
    
  } catch (error) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      correlationId,
      service: 'database-validation-canary',
      operation: 'CANARY_ERROR',
      data: { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      },
      message: 'Canary execution failed'
    }));
    
    // Add a failure check if we couldn't even connect
    if (checks.length === 0) {
      checks.push({
        name: 'canary_execution',
        description: 'Execute canary validation',
        status: 'FAIL',
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime
      });
    }
  } finally {
    if (client) {
      try {
        await client.end();
      } catch (closeError) {
        console.warn('Error closing database connection:', closeError);
      }
    }
  }
  
  // Calculate summary
  const passed = checks.filter(check => check.status === 'PASS').length;
  const failed = checks.filter(check => check.status === 'FAIL').length;
  const success = failed === 0;
  
  const result: CanaryResult = {
    success,
    checks,
    summary: {
      total: checks.length,
      passed,
      failed
    },
    timestamp: new Date().toISOString(),
    correlationId
  };
  
  // Log final result
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: success ? 'INFO' : 'ERROR',
    correlationId,
    service: 'database-validation-canary',
    operation: 'CANARY_COMPLETE',
    data: result,
    message: success ? 'Database validation canary completed successfully' : 'Database validation canary failed'
  }));
  
  // For CloudWatch Synthetics, we need to throw an error if any check failed
  if (!success) {
    const failedChecks = checks.filter(check => check.status === 'FAIL');
    throw new Error(`Database validation failed: ${failedChecks.map(c => c.name).join(', ')}`);
  }
  
  return result;
};
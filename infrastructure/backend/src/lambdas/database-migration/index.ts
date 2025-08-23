import { Handler, CloudFormationCustomResourceEvent } from 'aws-lambda';
import { SecretsManager } from 'aws-sdk';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

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

/**
 * Get database credentials from AWS Secrets Manager
 */
async function getDatabaseCredentials(): Promise<DatabaseCredentials> {
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
function createDatabaseConfig(credentials: DatabaseCredentials): DatabaseConfig {
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
 * Execute SQL script on the database
 */
async function executeSqlScript(client: Client, sqlContent: string, migrationName: string): Promise<void> {
  try {
    console.log(`Executing migration: ${migrationName}`);
    await client.query('BEGIN');
    
    // Split SQL content by statements (basic split on semicolon)
    const statements = sqlContent
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));

    for (const statement of statements) {
      if (statement.trim()) {
        console.log(`Executing: ${statement.substring(0, 100)}...`);
        await client.query(statement);
      }
    }
    
    await client.query('COMMIT');
    console.log(`Migration ${migrationName} completed successfully`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Error executing migration ${migrationName}:`, error);
    throw error;
  }
}

/**
 * Check if migration has already been applied
 */
async function isMigrationApplied(client: Client, version: string): Promise<boolean> {
  try {
    const result = await client.query(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [version]
    );
    return result.rows.length > 0;
  } catch (error) {
    // If table doesn't exist, migration hasn't been applied
    console.log('schema_migrations table does not exist yet, migration needed');
    return false;
  }
}

/**
 * Get list of migration files
 */
function getMigrationFiles(): Array<{ version: string; filename: string; filepath: string }> {
  const migrationsDir = path.join(__dirname, '../../migrations');
  
  if (!fs.existsSync(migrationsDir)) {
    console.log('No migrations directory found');
    return [];
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort();

  return files.map(file => {
    const version = file.replace('.sql', '');
    return {
      version,
      filename: file,
      filepath: path.join(migrationsDir, file)
    };
  });
}

/**
 * Run database migrations
 */
async function runMigrations(): Promise<void> {
  console.log('Starting database migrations...');
  
  const credentials = await getDatabaseCredentials();
  const dbConfig = createDatabaseConfig(credentials);
  
  const client = new Client({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.username,
    password: dbConfig.password,
    ssl: {
      rejectUnauthorized: false // Aurora requires SSL
    },
    connectionTimeoutMillis: 10000,
    query_timeout: 30000,
  });

  try {
    console.log(`Connecting to database at ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
    await client.connect();
    console.log('Connected to database successfully');

    // Test connection
    const testResult = await client.query('SELECT version()');
    console.log('PostgreSQL version:', testResult.rows[0].version);

    // Get migration files
    const migrations = getMigrationFiles();
    console.log(`Found ${migrations.length} migration files`);

    if (migrations.length === 0) {
      console.log('No migrations to run');
      return;
    }

    // Run each migration
    for (const migration of migrations) {
      console.log(`Checking migration: ${migration.version}`);
      
      const isApplied = await isMigrationApplied(client, migration.version);
      if (isApplied) {
        console.log(`Migration ${migration.version} already applied, skipping`);
        continue;
      }

      console.log(`Applying migration: ${migration.version}`);
      const sqlContent = fs.readFileSync(migration.filepath, 'utf8');
      await executeSqlScript(client, sqlContent, migration.version);
    }

    console.log('All migrations completed successfully');
    
  } catch (error) {
    console.error('Migration error:', error);
    throw error;
  } finally {
    try {
      await client.end();
      console.log('Database connection closed');
    } catch (error) {
      console.error('Error closing database connection:', error);
    }
  }
}

/**
 * Test database connection and vector operations
 */
async function testVectorOperations(): Promise<void> {
  console.log('Testing vector operations...');
  
  const credentials = await getDatabaseCredentials();
  const dbConfig = createDatabaseConfig(credentials);
  
  const client = new Client({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.username,
    password: dbConfig.password,
    ssl: {
      rejectUnauthorized: false
    },
    connectionTimeoutMillis: 10000,
    query_timeout: 30000,
  });

  try {
    await client.connect();
    
    // Test pgvector extension
    const vectorResult = await client.query("SELECT '1,2,3'::vector");
    console.log('Vector extension test:', vectorResult.rows[0]);

    // Test table existence
    const tableResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('document_embeddings', 'documents', 'schema_migrations')
    `);
    console.log('Created tables:', tableResult.rows);

    // Test vector operations
    console.log('Testing vector operations...');
    
    // Insert test vector
    const testVector = Array(1024).fill(0).map(() => Math.random()).join(',');
    await client.query(`
      INSERT INTO document_embeddings (document_id, content, embedding) 
      VALUES ($1, $2, $3::vector)
    `, ['test-doc-1', 'This is a test document', `[${testVector}]`]);

    // Test similarity search
    const similarityResult = await client.query(`
      SELECT document_id, content, embedding <=> $1::vector as distance 
      FROM document_embeddings 
      WHERE document_id = 'test-doc-1'
      ORDER BY embedding <=> $1::vector 
      LIMIT 1
    `, [`[${testVector}]`]);
    
    console.log('Similarity search test:', similarityResult.rows);

    // Clean up test data
    await client.query("DELETE FROM document_embeddings WHERE document_id = 'test-doc-1'");
    
    console.log('Vector operations test completed successfully');
    
  } catch (error) {
    console.error('Vector operations test error:', error);
    throw error;
  } finally {
    try {
      await client.end();
    } catch (error) {
      console.error('Error closing database connection:', error);
    }
  }
}

/**
 * Lambda handler for CloudFormation custom resource
 */
export const handler: Handler<CloudFormationCustomResourceEvent> = async (event, context): Promise<any> => {
  console.log('Database migration Lambda triggered');
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    // Run migrations
    await runMigrations();
    
    // Test vector operations
    await testVectorOperations();

    // Send success response to CloudFormation
    if (event.RequestType === 'Create' || event.RequestType === 'Update') {
      console.log('Database migrations completed successfully');
      
      return {
        Status: 'SUCCESS',
        Reason: 'Database migrations completed successfully',
        PhysicalResourceId: 'database-migration-' + Date.now(),
        Data: {
          MigrationStatus: 'SUCCESS',
          Message: 'Database schema created and pgvector extension enabled'
        }
      };
    } else if (event.RequestType === 'Delete') {
      console.log('Delete request - no action needed');
      return {
        Status: 'SUCCESS',
        Reason: 'Delete completed',
        PhysicalResourceId: event.PhysicalResourceId || 'database-migration'
      };
    }

  } catch (error) {
    console.error('Database migration failed:', error);
    
    return {
      Status: 'FAILED',
      Reason: `Database migration failed: ${(error as Error).message}`,
      PhysicalResourceId: (event as any).PhysicalResourceId || 'database-migration-failed'
    };
  }
};
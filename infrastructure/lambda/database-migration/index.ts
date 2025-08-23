import { Handler } from 'aws-lambda';
import { Client } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
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
        
      } catch (connError) {
        connectionAttempts++;
        console.warn(`Connection attempt ${connectionAttempts}/${maxAttempts} failed:`, connError);
        
        if (connectionAttempts >= maxAttempts) {
          throw new Error(`Failed to connect to database after ${maxAttempts} attempts: ${connError.message}`);
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

    // Read migration SQL from file
    const migrationSQL = fs.readFileSync(
      path.join(__dirname, '001_initial_pgvector_schema.sql'),
      'utf8'
    );
    console.log('Migration SQL loaded, length:', migrationSQL.length);
    
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
    
    await client.end();
    console.log('Database connection closed');
    
    // Send success response to CloudFormation
    await sendResponse(event, 'SUCCESS', {
      message: 'Database schema initialized successfully',
      tablesCreated: tableCheck.rows.map(row => row.table_name),
      migrationVersion: '001_initial_pgvector_schema'
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
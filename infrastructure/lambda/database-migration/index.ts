import { Handler } from 'aws-lambda';
import { Client } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import * as fs from 'fs';
import * as path from 'path';

interface DatabaseCredentials {
  username: string;
  password: string;
}

export const handler: Handler = async (event) => {
  console.log('Starting database schema initialization...');
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const secretsClient = new SecretsManagerClient({ 
    region: process.env.AWS_REGION || 'us-east-1'
  });
  
  try {
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
    
    // Connect to PostgreSQL
    console.log('Connecting to PostgreSQL cluster...');
    const client = new Client({
      host: process.env.DATABASE_CLUSTER_ENDPOINT,
      port: 5432,
      database: 'ragtime',
      user: credentials.username,
      password: credentials.password,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 30000,
      query_timeout: 60000,
    });
    
    await client.connect();
    console.log('Connected to database successfully');
    
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
    
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        message: 'Database schema initialized successfully',
        tablesCreated: tableCheck.rows.map(row => row.table_name)
      })
    };
    
  } catch (error) {
    console.error('Database initialization failed:', error);
    
    // Return failure details for CloudFormation
    throw new Error(`Database migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};
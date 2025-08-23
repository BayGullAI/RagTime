import { Client } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export interface DatabaseCredentials {
  username: string;
  password: string;
}

export class DatabaseClient {
  private client: Client | null = null;
  private secretsClient: SecretsManagerClient;

  constructor() {
    this.secretsClient = new SecretsManagerClient({
      region: process.env.AWS_REGION || 'us-east-1'
    });
  }

  private async getCredentials(): Promise<DatabaseCredentials> {
    const secretName = process.env.DATABASE_SECRET_NAME;
    if (!secretName) {
      throw new Error('DATABASE_SECRET_NAME environment variable not set');
    }

    const response = await this.secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretName })
    );

    if (!response.SecretString) {
      throw new Error('No secret string found in database secret');
    }

    return JSON.parse(response.SecretString);
  }

  async connect(): Promise<void> {
    if (this.client) {
      return; // Already connected
    }

    const credentials = await this.getCredentials();

    this.client = new Client({
      host: process.env.DATABASE_CLUSTER_ENDPOINT,
      port: 5432,
      database: process.env.DATABASE_NAME || 'ragtime',
      user: credentials.username,
      password: credentials.password,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 30000,
      query_timeout: 60000,
    });

    await this.client.connect();
    console.log('Connected to PostgreSQL database');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = null;
      console.log('Disconnected from PostgreSQL database');
    }
  }

  async query(text: string, params?: any[]): Promise<any> {
    if (!this.client) {
      throw new Error('Database not connected. Call connect() first.');
    }

    console.log('Executing query:', text.substring(0, 100) + '...');
    const result = await this.client.query(text, params);
    console.log(`Query executed successfully, returned ${result.rows.length} rows`);
    
    return result;
  }

  async transaction<T>(callback: (client: DatabaseClient) => Promise<T>): Promise<T> {
    await this.connect();
    
    try {
      await this.query('BEGIN');
      const result = await callback(this);
      await this.query('COMMIT');
      return result;
    } catch (error) {
      await this.query('ROLLBACK');
      throw error;
    } finally {
      await this.disconnect();
    }
  }
}
import { APIGatewayClient, GetRestApisCommand } from '@aws-sdk/client-api-gateway';

export interface Config {
  apiBaseUrl: string;
  tenantId: string;
  region: string;
}

async function findApiGatewayUrl(): Promise<string> {
  const client = new APIGatewayClient({ region: process.env.AWS_REGION || 'us-east-1' });
  
  try {
    const response = await client.send(new GetRestApisCommand({}));
    const ragTimeApi = response.items?.find(api => 
      api.name?.includes('RagTime') || api.name?.includes('ragtime')
    );
    
    if (ragTimeApi) {
      const region = process.env.AWS_REGION || 'us-east-1';
      return `https://${ragTimeApi.id}.execute-api.${region}.amazonaws.com/prod`;
    }
  } catch (error) {
    // Fallback to environment variable or default
  }
  
  // Try environment variable or throw error
  if (process.env.RAGTIME_API_URL) {
    return process.env.RAGTIME_API_URL;
  }
  
  throw new Error(
    'Could not find RagTime API Gateway. Set RAGTIME_API_URL environment variable or ensure AWS credentials are configured.'
  );
}

export async function getConfig(): Promise<Config> {
  const tenantId = process.env.RAGTIME_TENANT_ID || 'default-tenant';
  const region = process.env.AWS_REGION || 'us-east-1';
  const apiBaseUrl = await findApiGatewayUrl();
  
  return {
    apiBaseUrl,
    tenantId,
    region
  };
}
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { IOpenAIService, EmbeddingResponse } from '../interfaces/openai.interface';

export interface OpenAICredentials {
  api_key: string;
}

export class OpenAIService implements IOpenAIService {
  private secretsClient: SecretsManagerClient;

  constructor() {
    this.secretsClient = new SecretsManagerClient({
      region: process.env.AWS_REGION || 'us-east-1'
    });
  }

  private async getApiKey(): Promise<string> {
    const secretName = process.env.OPENAI_SECRET_NAME;
    if (!secretName) {
      throw new Error('OPENAI_SECRET_NAME environment variable not set');
    }

    const response = await this.secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretName })
    );

    if (!response.SecretString) {
      throw new Error('No secret string found in OpenAI secret');
    }

    const credentials: OpenAICredentials = JSON.parse(response.SecretString);
    return credentials.api_key;
  }

  async createEmbedding(text: string, model: string = 'text-embedding-3-small'): Promise<EmbeddingResponse> {
    const apiKey = await this.getApiKey();

    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        input: text,
        model: model
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    if (!data.data || !data.data[0] || !data.data[0].embedding) {
      throw new Error('Invalid response from OpenAI embeddings API');
    }

    return {
      embedding: data.data[0].embedding,
      tokens: data.usage?.total_tokens || 0
    };
  }

  async createEmbeddings(texts: string[], model: string = 'text-embedding-3-small'): Promise<EmbeddingResponse[]> {
    const apiKey = await this.getApiKey();

    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        input: texts,
        model: model
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error('Invalid response from OpenAI embeddings API');
    }

    return data.data.map((item: any, index: number) => ({
      embedding: item.embedding,
      tokens: Math.floor((data.usage?.total_tokens || 0) / texts.length)
    }));
  }
}
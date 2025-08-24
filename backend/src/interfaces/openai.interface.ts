/**
 * OpenAI service abstraction interface for dependency injection
 */

export interface EmbeddingResponse {
  embedding: number[];
  tokens: number;
}

export interface IOpenAIService {
  createEmbedding(text: string, model?: string): Promise<EmbeddingResponse>;
  createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse[]>;
}
/**
 * Text processing service abstraction interface for dependency injection
 */

export interface TextChunk {
  index: number;
  content: string;
  startChar: number;
  endChar: number;
}

export interface ProcessDocumentRequest {
  text: string;
  documentId: string;
  chunkSize?: number;
  chunkOverlap?: number;
  correlationId?: string;
  embeddingModel?: string;
}

export interface ProcessDocumentResult {
  documentId: string;
  totalChunks: number;
  chunks: Array<{
    index: number;
    content: string;
    embedding: number[];
    tokens: number;
  }>;
  totalTokens: number;
}

export interface ITextProcessingService {
  processDocument(request: ProcessDocumentRequest): Promise<ProcessDocumentResult>;

  searchSimilar(
    query: string, 
    limit?: number,
    threshold?: number
  ): Promise<Array<{
    documentId: string;
    chunkIndex: number;
    content: string;
    similarity: number;
    metadata?: any;
  }>>;
}
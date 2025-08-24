/**
 * Document service abstraction interface for dependency injection
 */

export interface DocumentEmbedding {
  documentId: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
  metadata?: any;
}

export interface SimilaritySearchResult {
  documentId: string;
  chunkIndex: number;
  content: string;
  similarity: number;
  metadata?: any;
}

export interface IDocumentService {
  storeDocumentEmbeddings(
    documentId: string,
    chunks: Array<{
      index: number;
      content: string;
      embedding: number[];
      tokens?: number;
    }>,
    correlationId?: string,
    processingStage?: string,
    embeddingModel?: string
  ): Promise<void>;

  searchSimilarEmbeddings(
    queryEmbedding: number[],
    limit?: number,
    threshold?: number
  ): Promise<SimilaritySearchResult[]>;

  getDocumentChunks(documentId: string): Promise<DocumentEmbedding[]>;

  updateDocumentMetadata(
    documentId: string,
    metadata: {
      correlationId?: string;
      sourceUrl?: string;
      extractionMethod?: string;
      wordCount?: number;
      characterCount?: number;
      processingDuration?: number;
      status?: string;
      originalFilename?: string;
      contentType?: string;
      fileSize?: number;
    }
  ): Promise<void>;

  deleteDocument(documentId: string): Promise<void>;
}
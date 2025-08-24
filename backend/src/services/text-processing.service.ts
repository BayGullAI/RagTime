import { OpenAIService } from './openai.service';
import { DocumentService } from './document.service';

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
  fileName?: string;
}

export interface ProcessDocumentResult {
  documentId: string;
  totalChunks: number;
  chunks: Array<{
    index: number;
    content: string;
    embedding?: number[]; // Optional to support lightweight responses
    tokens: number;
  }>;
  totalTokens: number;
}

export class TextProcessingService {
  private openAIService: OpenAIService;
  private documentService: DocumentService;
  private logger: any; // Will be injected

  constructor(openAIService: OpenAIService, logger?: any) {
    this.openAIService = openAIService;
    this.documentService = new DocumentService();
    this.logger = logger;
  }

  /**
   * Split text into overlapping chunks
   */
  private chunkText(text: string, chunkSize: number = 1000, overlap: number = 200): TextChunk[] {
    const chunks: TextChunk[] = [];
    let startChar = 0;
    let chunkIndex = 0;

    while (startChar < text.length) {
      let endChar = Math.min(startChar + chunkSize, text.length);
      
      // Try to break at a sentence boundary if we're not at the end
      if (endChar < text.length) {
        const sentenceEnd = text.lastIndexOf('.', endChar);
        const paragraphEnd = text.lastIndexOf('\n\n', endChar);
        const breakPoint = Math.max(sentenceEnd, paragraphEnd);
        
        if (breakPoint > startChar + chunkSize / 2) {
          endChar = breakPoint + 1;
        } else {
          // Fall back to word boundary
          const lastSpace = text.lastIndexOf(' ', endChar);
          if (lastSpace > startChar + chunkSize / 2) {
            endChar = lastSpace;
          }
        }
      }

      const content = text.slice(startChar, endChar).trim();
      if (content.length > 0) {
        chunks.push({
          index: chunkIndex,
          content,
          startChar,
          endChar: endChar
        });
        chunkIndex++;
      }

      // Move start position with overlap
      const nextStartChar = endChar - overlap;
      if (nextStartChar <= startChar) {
        break; // Prevent infinite loop if startChar does not advance
      }
      startChar = nextStartChar;
    }

    return chunks;
  }

  /**
   * Process a document by chunking and generating embeddings
   */
  async processDocument(request: ProcessDocumentRequest): Promise<ProcessDocumentResult> {
    const { text, documentId, chunkSize = 1000, chunkOverlap = 200, correlationId, embeddingModel, fileName } = request;

    // Chunk the text
    const textChunks = this.chunkText(text, chunkSize, chunkOverlap);
    
    if (this.logger) {
      this.logger.info('CHUNKS_CREATED', {
        documentId: documentId,
        chunkCount: textChunks.length,
        chunkSize: chunkSize,
        chunkOverlap: chunkOverlap,
        chunks: textChunks.map(chunk => ({
          chunkId: `${documentId}_chunk_${chunk.index}`,
          index: chunk.index,
          size: chunk.content.length,
          wordCount: chunk.content.split(/\s+/).length,
          preview: chunk.content.substring(0, 100) + '...'
        }))
      }, `Created ${textChunks.length} chunks for document ${documentId}`);
    }

    // Generate embeddings for all chunks
    const chunkTexts = textChunks.map(chunk => chunk.content);
    
    if (this.logger) {
      this.logger.pipelineStage('STEP4_EMBEDDINGS_START', {
        documentId: documentId,
        chunkCount: chunkTexts.length,
        embeddingModel: embeddingModel || 'text-embedding-3-small',
        step: '4/5',
        stepName: 'EMBEDDINGS_GENERATION'
      }, `Pipeline Step 4/5: Starting embeddings generation for ${chunkTexts.length} chunks`);

      this.logger.info('EMBEDDINGS_START', {
        documentId: documentId,
        chunkCount: chunkTexts.length,
        embeddingModel: embeddingModel || 'text-embedding-3-small',
        totalTextLength: chunkTexts.reduce((sum, text) => sum + text.length, 0)
      }, `Starting embeddings generation for ${chunkTexts.length} chunks`);
    }
    
    const embeddings = await this.openAIService.createEmbeddings(chunkTexts, embeddingModel);
    
    if (this.logger) {
      this.logger.pipelineStage('STEP4_EMBEDDINGS_COMPLETE', {
        documentId: documentId,
        embeddingModel: embeddingModel || 'text-embedding-3-small',
        embeddingsGenerated: embeddings.length,
        totalTokensUsed: embeddings.reduce((sum, emb) => sum + emb.tokens, 0),
        step: '4/5',
        stepName: 'EMBEDDINGS_GENERATION',
        nextStep: 'PGVECTOR_STORAGE'
      }, `Pipeline Step 4/5 Complete: Generated ${embeddings.length} embeddings using ${embeddingModel || 'text-embedding-3-small'}`);

      this.logger.info('EMBEDDINGS_COMPLETE', {
        documentId: documentId,
        embeddingModel: embeddingModel || 'text-embedding-3-small',
        embeddingsGenerated: embeddings.length,
        totalTokensUsed: embeddings.reduce((sum, emb) => sum + emb.tokens, 0),
        embeddings: embeddings.map((emb, index) => ({
          chunkId: `${documentId}_chunk_${index}`,
          chunkIndex: index,
          embeddingDimensions: emb.embedding.length,
          tokensUsed: emb.tokens
        }))
      }, `Generated ${embeddings.length} embeddings using ${embeddingModel || 'text-embedding-3-small'}`);
    }

    // Combine chunks with embeddings
    const processedChunks = textChunks.map((chunk, index) => ({
      index: chunk.index,
      content: chunk.content,
      embedding: embeddings[index].embedding,
      tokens: embeddings[index].tokens
    }));

    // Store embeddings in database with correlation tracking
    if (this.logger) {
      this.logger.pipelineStage('STEP5_PGVECTOR_START', {
        documentId: documentId,
        embeddingsToStore: processedChunks.length,
        correlationId: correlationId,
        step: '5/5',
        stepName: 'PGVECTOR_STORAGE'
      }, `Pipeline Step 5/5: Starting pgvector storage for ${processedChunks.length} embeddings`);

      this.logger.info('PGVECTOR_STORAGE_START', {
        documentId: documentId,
        embeddingsToStore: processedChunks.length,
        correlationId: correlationId
      }, `Starting pgvector storage for ${processedChunks.length} embeddings`);
    }
    
    await this.documentService.storeDocumentEmbeddings(
      documentId,
      processedChunks,
      correlationId,
      'TEXT_PROCESSING',
      embeddingModel || 'text-embedding-3-small',
      fileName
    );
    
    if (this.logger) {
      this.logger.pipelineStage('STEP5_PGVECTOR_COMPLETE', {
        documentId: documentId,
        embeddingsStored: processedChunks.length,
        correlationId: correlationId,
        step: '5/5',
        stepName: 'PGVECTOR_STORAGE',
        status: 'STORAGE_COMPLETE'
      }, `Pipeline Step 5/5 Complete: Stored ${processedChunks.length} embeddings in pgvector database`);

      this.logger.info('PGVECTOR_STORAGE_COMPLETE', {
        documentId: documentId,
        embeddingsStored: processedChunks.length,
        correlationId: correlationId,
        embeddingModel: embeddingModel || 'text-embedding-3-small',
        storedChunks: processedChunks.map(chunk => ({
          chunkId: `${documentId}_chunk_${chunk.index}`,
          chunkIndex: chunk.index,
          contentLength: chunk.content.length,
          embeddingDimensions: chunk.embedding.length
        }))
      }, `Stored ${processedChunks.length} embeddings in pgvector database`);
    }

    const totalTokens = processedChunks.reduce((sum, chunk) => sum + chunk.tokens, 0);

    return {
      documentId,
      totalChunks: processedChunks.length,
      chunks: processedChunks.map(chunk => ({
        index: chunk.index,
        content: chunk.content,
        tokens: chunk.tokens
        // embedding vector excluded to prevent memory issues
      })),
      totalTokens
    };
  }

  /**
   * Search for similar text chunks using vector similarity
   */
  async searchSimilar(
    query: string, 
    limit: number = 10,
    threshold: number = 0.7
  ): Promise<Array<{
    documentId: string;
    chunkIndex: number;
    content: string;
    similarity: number;
    metadata?: any;
  }>> {
    // Generate embedding for the query
    const queryEmbedding = await this.openAIService.createEmbedding(query);

    // Search in database
    return await this.documentService.searchSimilarEmbeddings(
      queryEmbedding.embedding,
      limit,
      threshold
    );
  }
}
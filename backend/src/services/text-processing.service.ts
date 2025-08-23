import { OpenAIService, EmbeddingResponse } from './openai.service';
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

export class TextProcessingService {
  private openAIService: OpenAIService;
  private documentService: DocumentService;

  constructor(openAIService: OpenAIService) {
    this.openAIService = openAIService;
    this.documentService = new DocumentService();
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
      startChar = endChar - overlap;
      if (startChar >= text.length) break;
    }

    return chunks;
  }

  /**
   * Process a document by chunking and generating embeddings
   */
  async processDocument(request: ProcessDocumentRequest): Promise<ProcessDocumentResult> {
    const { text, documentId, chunkSize = 1000, chunkOverlap = 200 } = request;

    // Chunk the text
    const textChunks = this.chunkText(text, chunkSize, chunkOverlap);
    console.log(`Created ${textChunks.length} chunks for document ${documentId}`);

    // Generate embeddings for all chunks
    const chunkTexts = textChunks.map(chunk => chunk.content);
    const embeddings = await this.openAIService.createEmbeddings(chunkTexts);

    // Combine chunks with embeddings
    const processedChunks = textChunks.map((chunk, index) => ({
      index: chunk.index,
      content: chunk.content,
      embedding: embeddings[index].embedding,
      tokens: embeddings[index].tokens
    }));

    // Store embeddings in database
    await this.documentService.storeDocumentEmbeddings(
      documentId,
      processedChunks
    );

    const totalTokens = processedChunks.reduce((sum, chunk) => sum + chunk.tokens, 0);

    return {
      documentId,
      totalChunks: processedChunks.length,
      chunks: processedChunks,
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
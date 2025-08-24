import { IDatabaseClient } from '../interfaces/database.interface';
import { 
  IDocumentService, 
  DocumentEmbedding, 
  SimilaritySearchResult 
} from '../interfaces/document.interface';

export class DocumentService implements IDocumentService {
  private db: IDatabaseClient;

  constructor(databaseClient: IDatabaseClient) {
    this.db = databaseClient;
  }

  /**
   * Store document embeddings in the database
   */
  async storeDocumentEmbeddings(
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
  ): Promise<void> {
    await this.db.connect();

    try {
      // Begin transaction
      await this.db.query('BEGIN');

      // Update or insert document record with correlation tracking
      await this.db.query(
        `INSERT INTO documents (asset_id, total_chunks, status, correlation_id, updated_at) 
         VALUES ($1, $2, 'completed', $3, NOW())
         ON CONFLICT (asset_id) 
         DO UPDATE SET total_chunks = $2, status = 'completed', correlation_id = $3, updated_at = NOW()`,
        [documentId, chunks.length, correlationId]
      );

      // Delete existing embeddings for this document
      await this.db.query(
        'DELETE FROM document_embeddings WHERE asset_id = $1',
        [documentId]
      );

      // Insert new embeddings with correlation tracking
      for (const chunk of chunks) {
        const chunkWordCount = chunk.content.split(/\s+/).length;
        await this.db.query(
          `INSERT INTO document_embeddings 
           (asset_id, chunk_index, content, embedding, correlation_id, processing_stage, 
            chunk_word_count, embedding_model, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
          [
            documentId,
            chunk.index,
            chunk.content,
            JSON.stringify(chunk.embedding),
            correlationId,
            processingStage || 'EMBEDDING_GENERATION',
            chunkWordCount,
            embeddingModel || 'text-embedding-3-small'
          ]
        );
      }

      // Commit transaction
      await this.db.query('COMMIT');
      console.log(`Stored ${chunks.length} embeddings for document ${documentId}`);

    } catch (error) {
      // Rollback on error
      await this.db.query('ROLLBACK');
      throw error;
    } finally {
      await this.db.disconnect();
    }
  }

  /**
   * Search for similar embeddings using vector similarity
   */
  async searchSimilarEmbeddings(
    queryEmbedding: number[],
    limit: number = 10,
    threshold: number = 0.7
  ): Promise<SimilaritySearchResult[]> {
    await this.db.connect();

    try {
      const query = `
        SELECT 
          document_id,
          chunk_index,
          content,
          metadata,
          1 - (embedding <=> $1::vector) as similarity
        FROM document_embeddings
        WHERE 1 - (embedding <=> $1::vector) > $2
        ORDER BY embedding <=> $1::vector
        LIMIT $3
      `;

      const result = await this.db.query(query, [
        JSON.stringify(queryEmbedding),
        threshold,
        limit
      ]);

      return result.rows.map((row: any) => ({
        documentId: row.document_id,
        chunkIndex: row.chunk_index,
        content: row.content,
        similarity: parseFloat(row.similarity),
        metadata: row.metadata
      }));

    } finally {
      await this.db.disconnect();
    }
  }

  /**
   * Get document chunks by document ID
   */
  async getDocumentChunks(documentId: string): Promise<DocumentEmbedding[]> {
    await this.db.connect();

    try {
      const result = await this.db.query(
        `SELECT document_id, chunk_index, content, embedding, metadata
         FROM document_embeddings 
         WHERE document_id = $1 
         ORDER BY chunk_index`,
        [documentId]
      );

      return result.rows.map((row: any) => ({
        documentId: row.document_id,
        chunkIndex: row.chunk_index,
        content: row.content,
        embedding: JSON.parse(row.embedding),
        metadata: row.metadata
      }));

    } finally {
      await this.db.disconnect();
    }
  }

  /**
   * Update document metadata with correlation tracking
   */
  async updateDocumentMetadata(
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
  ): Promise<void> {
    await this.db.connect();

    try {
      const fields = [];
      const values = [];
      let paramIndex = 1;

      if (metadata.correlationId !== undefined) {
        fields.push(`correlation_id = $${paramIndex++}`);
        values.push(metadata.correlationId);
      }
      if (metadata.sourceUrl !== undefined) {
        fields.push(`source_url = $${paramIndex++}`);
        values.push(metadata.sourceUrl);
      }
      if (metadata.extractionMethod !== undefined) {
        fields.push(`extraction_method = $${paramIndex++}`);
        values.push(metadata.extractionMethod);
      }
      if (metadata.wordCount !== undefined) {
        fields.push(`word_count = $${paramIndex++}`);
        values.push(metadata.wordCount);
      }
      if (metadata.characterCount !== undefined) {
        fields.push(`character_count = $${paramIndex++}`);
        values.push(metadata.characterCount);
      }
      if (metadata.processingDuration !== undefined) {
        fields.push(`processing_duration = $${paramIndex++}`);
        values.push(metadata.processingDuration);
      }
      if (metadata.status !== undefined) {
        fields.push(`status = $${paramIndex++}`);
        values.push(metadata.status);
      }
      if (metadata.originalFilename !== undefined) {
        fields.push(`original_filename = $${paramIndex++}`);
        values.push(metadata.originalFilename);
      }
      if (metadata.contentType !== undefined) {
        fields.push(`content_type = $${paramIndex++}`);
        values.push(metadata.contentType);
      }
      if (metadata.fileSize !== undefined) {
        fields.push(`file_size = $${paramIndex++}`);
        values.push(metadata.fileSize);
      }

      if (fields.length > 0) {
        fields.push('updated_at = NOW()');
        values.push(documentId);

        await this.db.query(
          `UPDATE documents SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
          values
        );
      }

    } finally {
      await this.db.disconnect();
    }
  }

  /**
   * Delete document and all its embeddings
   */
  async deleteDocument(documentId: string): Promise<void> {
    await this.db.connect();

    try {
      await this.db.query('BEGIN');

      // Delete embeddings
      await this.db.query(
        'DELETE FROM document_embeddings WHERE asset_id = $1',
        [documentId]
      );

      // Delete document record
      await this.db.query(
        'DELETE FROM documents WHERE id = $1',
        [documentId]
      );

      await this.db.query('COMMIT');
      console.log(`Deleted document ${documentId} and all its embeddings`);

    } catch (error) {
      await this.db.query('ROLLBACK');
      throw error;
    } finally {
      await this.db.disconnect();
    }
  }
}
import { DatabaseClient } from '../lib/database';

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

export class DocumentService {
  private db: DatabaseClient;

  constructor() {
    this.db = new DatabaseClient();
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
    }>
  ): Promise<void> {
    await this.db.connect();

    try {
      // Begin transaction
      await this.db.query('BEGIN');

      // Update or insert document record
      await this.db.query(
        `INSERT INTO documents (id, total_chunks, status, updated_at) 
         VALUES ($1, $2, 'completed', NOW())
         ON CONFLICT (id) 
         DO UPDATE SET total_chunks = $2, status = 'completed', updated_at = NOW()`,
        [documentId, chunks.length]
      );

      // Delete existing embeddings for this document
      await this.db.query(
        'DELETE FROM document_embeddings WHERE document_id = $1',
        [documentId]
      );

      // Insert new embeddings
      for (const chunk of chunks) {
        await this.db.query(
          `INSERT INTO document_embeddings 
           (document_id, chunk_index, content, embedding, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW())`,
          [
            documentId,
            chunk.index,
            chunk.content,
            JSON.stringify(chunk.embedding)
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

      return result.rows.map(row => ({
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

      return result.rows.map(row => ({
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
   * Delete document and all its embeddings
   */
  async deleteDocument(documentId: string): Promise<void> {
    await this.db.connect();

    try {
      await this.db.query('BEGIN');

      // Delete embeddings
      await this.db.query(
        'DELETE FROM document_embeddings WHERE document_id = $1',
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
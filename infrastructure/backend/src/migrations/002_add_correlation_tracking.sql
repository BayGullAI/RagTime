-- Migration: 002_add_correlation_tracking
-- Description: Add correlation tracking fields for pipeline monitoring and traceability
-- Created: 2025-08-23

-- Add correlation tracking fields to documents table
ALTER TABLE documents 
ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(100),
ADD COLUMN IF NOT EXISTS source_url TEXT,
ADD COLUMN IF NOT EXISTS extraction_method VARCHAR(50),
ADD COLUMN IF NOT EXISTS word_count INTEGER,
ADD COLUMN IF NOT EXISTS character_count INTEGER,
ADD COLUMN IF NOT EXISTS processing_duration INTEGER; -- in milliseconds

-- Add correlation tracking fields to document_embeddings table
ALTER TABLE document_embeddings 
ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(100),
ADD COLUMN IF NOT EXISTS processing_stage VARCHAR(50),
ADD COLUMN IF NOT EXISTS chunk_word_count INTEGER,
ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(100),
ADD COLUMN IF NOT EXISTS embedding_duration INTEGER; -- in milliseconds

-- Create indexes for efficient correlation tracking queries
CREATE INDEX IF NOT EXISTS documents_correlation_id_idx 
    ON documents (correlation_id);

CREATE INDEX IF NOT EXISTS document_embeddings_correlation_id_idx 
    ON document_embeddings (correlation_id);

-- Create index for processing stage queries (useful for monitoring pipeline stages)
CREATE INDEX IF NOT EXISTS document_embeddings_processing_stage_idx 
    ON document_embeddings (processing_stage);

-- Create composite index for correlation tracking and status
CREATE INDEX IF NOT EXISTS documents_correlation_status_idx 
    ON documents (correlation_id, status);

-- Create index for time-based correlation queries
CREATE INDEX IF NOT EXISTS documents_created_correlation_idx 
    ON documents (created_at, correlation_id);

-- Record this migration
INSERT INTO schema_migrations (version, description) 
VALUES ('002_add_correlation_tracking', 'Add correlation tracking fields for pipeline monitoring and traceability')
ON CONFLICT (version) DO NOTHING;

-- Add comments for documentation
COMMENT ON COLUMN documents.correlation_id IS 'Unique identifier for tracking documents through the processing pipeline';
COMMENT ON COLUMN documents.source_url IS 'Original URL or source location of the document if uploaded from URL';
COMMENT ON COLUMN documents.extraction_method IS 'Method used to extract text (upload, url, pdf_extraction, etc.)';
COMMENT ON COLUMN documents.word_count IS 'Total number of words in the original document';
COMMENT ON COLUMN documents.character_count IS 'Total number of characters in the original document';
COMMENT ON COLUMN documents.processing_duration IS 'Total time in milliseconds to process the document';

COMMENT ON COLUMN document_embeddings.correlation_id IS 'Links embedding to original document processing pipeline';
COMMENT ON COLUMN document_embeddings.processing_stage IS 'Pipeline stage where this embedding was created (chunking, embedding, etc.)';
COMMENT ON COLUMN document_embeddings.chunk_word_count IS 'Number of words in this specific chunk';
COMMENT ON COLUMN document_embeddings.embedding_model IS 'Model used to generate this embedding (e.g., text-embedding-3-small)';
COMMENT ON COLUMN document_embeddings.embedding_duration IS 'Time in milliseconds to generate this specific embedding';
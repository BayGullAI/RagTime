-- Migration: 001_initial_pgvector_schema
-- Description: Create pgvector extension and initial schema for vector embeddings
-- Created: 2025-08-22

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create document_embeddings table for storing vector embeddings
CREATE TABLE IF NOT EXISTS document_embeddings (
    id SERIAL PRIMARY KEY,
    document_id VARCHAR(255) NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL,
    embedding VECTOR(1536) NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for efficient vector similarity search
-- IVFFlat index for cosine similarity search (good for most use cases)
CREATE INDEX IF NOT EXISTS document_embeddings_embedding_cosine_idx 
    ON document_embeddings USING ivfflat (embedding vector_cosine_ops) 
    WITH (lists = 100);

-- Index for filtering by document_id
CREATE INDEX IF NOT EXISTS document_embeddings_document_id_idx 
    ON document_embeddings (document_id);

-- Index for filtering by document_id and chunk_index
CREATE INDEX IF NOT EXISTS document_embeddings_document_chunk_idx 
    ON document_embeddings (document_id, chunk_index);

-- Index for created_at for time-based queries
CREATE INDEX IF NOT EXISTS document_embeddings_created_at_idx 
    ON document_embeddings (created_at);

-- Create documents table for document metadata
CREATE TABLE IF NOT EXISTS documents (
    id VARCHAR(255) PRIMARY KEY,
    original_filename VARCHAR(512) NOT NULL,
    content_type VARCHAR(100),
    file_size INTEGER,
    total_chunks INTEGER DEFAULT 0,
    status VARCHAR(50) DEFAULT 'processing',
    error_message TEXT,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for status filtering
CREATE INDEX IF NOT EXISTS documents_status_idx ON documents (status);

-- Index for created_at
CREATE INDEX IF NOT EXISTS documents_created_at_idx ON documents (created_at);

-- Create migration tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    description TEXT
);

-- Record this migration
INSERT INTO schema_migrations (version, description) 
VALUES ('001_initial_pgvector_schema', 'Create pgvector extension and initial schema for vector embeddings')
ON CONFLICT (version) DO NOTHING;

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE 'plpgsql';

-- Create triggers to automatically update updated_at
DROP TRIGGER IF EXISTS update_document_embeddings_updated_at ON document_embeddings;
CREATE TRIGGER update_document_embeddings_updated_at
    BEFORE UPDATE ON document_embeddings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_documents_updated_at ON documents;
CREATE TRIGGER update_documents_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
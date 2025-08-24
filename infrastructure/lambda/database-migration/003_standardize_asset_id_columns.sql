-- Migration: 003_standardize_asset_id_columns
-- Description: Standardize to use asset_id consistently across all tables
-- Created: 2025-08-24

-- Rename columns to use consistent asset_id naming
-- This avoids confusion between id/document_id for the same data

-- Update documents table: rename id -> asset_id
ALTER TABLE documents RENAME COLUMN id TO asset_id;

-- Update document_embeddings table: rename document_id -> asset_id  
ALTER TABLE document_embeddings RENAME COLUMN document_id TO asset_id;

-- Update indexes to use new column name
DROP INDEX IF EXISTS document_embeddings_document_id_idx;
CREATE INDEX IF NOT EXISTS document_embeddings_asset_id_idx 
    ON document_embeddings (asset_id);

DROP INDEX IF EXISTS document_embeddings_document_chunk_idx;
CREATE INDEX IF NOT EXISTS document_embeddings_asset_chunk_idx 
    ON document_embeddings (asset_id, chunk_index);

-- Record this migration
INSERT INTO schema_migrations (version, description) 
VALUES ('003_standardize_asset_id_columns', 'Standardize to use asset_id consistently across all tables')
ON CONFLICT (version) DO NOTHING;
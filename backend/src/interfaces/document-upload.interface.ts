/**
 * Document Upload Service Interface
 * Phase 4: Business logic extraction
 */

export interface MultipartFile {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface ParsedMultipartData {
  files: MultipartFile[];
  fields: Record<string, string>;
}

export interface ValidatedUploadInput {
  tenantId: string;
  file: MultipartFile;
}

export interface UploadedFile {
  bucket: string;
  key: string;
}

export interface DocumentMetadata {
  tenant_id: string;
  asset_id: string;
  file_name: string;
  file_size: number;
  content_type: string;
  s3_bucket: string;
  s3_key: string;
  status: 'UPLOADED' | 'PROCESSED' | 'FAILED';
  created_at: string;
  updated_at: string;
  error_message?: string;
  correlation_id: string;
  source_url?: string;
  extraction_method?: string;
  word_count?: number;
  gsi1_sk: string;
  gsi2_pk: string;
  gsi2_sk: string;
}

export interface ProcessingResult {
  success: boolean;
  documentMetadata: DocumentMetadata;
  processingTime: number;
  uploadedFile: UploadedFile;
}

export interface IDocumentUploadService {
  /**
   * Parse multipart form data from HTTP request body
   */
  parseMultipartFormData(body: string, boundary: string): ParsedMultipartData;

  /**
   * Validate upload input fields and files
   */
  validateUploadInput(fields: Record<string, string>, files: MultipartFile[]): ValidatedUploadInput;

  /**
   * Upload file to S3 storage
   */
  uploadToS3(file: MultipartFile, assetId: string, tenantId: string, correlationId: string): Promise<UploadedFile>;

  /**
   * Save document metadata to database
   */
  saveDocumentMetadata(metadata: DocumentMetadata, correlationId: string): Promise<void>;

  /**
   * Update document status in database
   */
  updateDocumentStatus(
    tenantId: string,
    assetId: string,
    status: DocumentMetadata['status'],
    correlationId: string,
    errorMessage?: string
  ): Promise<void>;

  /**
   * Trigger text processing pipeline
   */
  triggerTextProcessing(
    file: MultipartFile,
    assetId: string,
    s3Bucket: string,
    s3Key: string,
    correlationId: string
  ): Promise<void>;

  /**
   * Orchestrate the entire document upload and processing pipeline
   */
  processDocumentUpload(
    requestBody: string,
    boundary: string,
    correlationId: string
  ): Promise<ProcessingResult>;
}
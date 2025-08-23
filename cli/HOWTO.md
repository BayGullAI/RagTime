# RagTime CLI - How To Use

The RagTime CLI provides simple document management for the RagTime RAG system.

## Installation

1. Build the CLI:
```bash
cd cli
npm install
npm run build
```

2. Link globally (optional):
```bash
npm link
```

## Configuration

Set these environment variables:

```bash
# Required: AWS credentials (standard AWS CLI credentials)
export AWS_REGION=us-east-1
export AWS_PROFILE=your-profile

# Optional: Custom tenant ID (defaults to 'default-tenant')
export RAGTIME_TENANT_ID=your-tenant-id

# Optional: Custom API URL (auto-discovered if not set)
export RAGTIME_API_URL=https://your-api-gateway.execute-api.us-east-1.amazonaws.com/prod
```

## Commands

### Upload Documents

Upload a text file:
```bash
ragtime upload document.txt
```

Upload string content directly:
```bash
ragtime upload "This is my document content" --name my-doc.txt
# or
ragtime upload --string "This is my document content" --name my-doc.txt
```

Upload content from URL:
```bash
ragtime upload https://example.com/document.txt
# or
ragtime upload --url https://example.com/document.txt --name downloaded-doc.txt
```

### List Documents

```bash
ragtime list
```

Example output:
```
┌─────────────────┬─────────────────────────┬────────────┬────────────────────┬──────────┐
│ ID              │ NAME                    │ STATUS     │ UPLOADED           │ SIZE     │
├─────────────────┼─────────────────────────┼────────────┼────────────────────┼──────────┤
│ abc-123-def...  │ contract.pdf            │ PROCESSED  │ 1/15/2024, 10:30   │ 2048.0KB │
│ def-456-ghi...  │ report.txt              │ FAILED     │ 1/15/2024, 9:15    │ 156.2KB  │
│ ghi-789-jkl...  │ manual.docx             │ PROCESSING │ 1/15/2024, 11:45   │ 892.1KB  │
└─────────────────┴─────────────────────────┴────────────┴────────────────────┴──────────┘

Total: 3 documents
```

### Get Document Details

```bash
ragtime get abc-123-def-456
```

Example output:
```
🔍 Analyzing document: abc-123-def-456

📊 DynamoDB Metadata:
  Document ID: abc-123-def-456
  Filename: contract.pdf
  Status: PROCESSED
  Size: 2048.0KB
  Content Type: application/pdf
  Created: 1/15/2024, 10:30:25 AM
  Updated: 1/15/2024, 10:30:48 AM
  Word Count: 1250
```

### Comprehensive Pipeline Analysis

```bash
ragtime get abc-123-def-456 --status
```

This performs end-to-end verification of the entire document processing pipeline:

Example output:
```
🔍 Analyzing document: abc-123-def-456

📊 DynamoDB Metadata:
  Document ID: abc-123-def-456
  Filename: contract.pdf
  Status: PROCESSED
  Size: 2048.0KB
  Content Type: application/pdf
  Created: 1/15/2024, 10:30:25 AM
  Updated: 1/15/2024, 10:30:48 AM
  Word Count: 1250

🗄️ S3 Storage Verification:
  ✅ S3 Object: EXISTS
  Bucket: ragtime-documents-dev-174919262752-us-east-1
  Key: documents/default-tenant/abc-123-def-456/contract.pdf
  S3 Size: 2048.0KB
  Last Modified: 1/15/2024, 10:30:26 AM
  Content Type: application/pdf
  Preview: "Contract Agreement between..."

🗃️ PostgreSQL Metadata:
  ✅ Document Record: EXISTS
  Original Filename: contract.pdf
  Content Type: application/pdf
  File Size: 2048.0KB
  Total Chunks: 15
  PG Status: PROCESSED
  PG Created: 1/15/2024, 10:30:28 AM

🧩 Embeddings & Chunks Analysis:
  ✅ Embeddings: 15 FOUND
  Unique Chunks: 15
  Avg Content Length: 347 characters
  First Embedding: 1/15/2024, 10:30:35 AM
  Last Embedding: 1/15/2024, 10:30:42 AM

  📋 Chunk Details:
  ┌────────┬────────────────────────────────────────┬────────┬──────────────────────┐
  │ Index  │ Content Preview                        │ Length │ Created              │
  ├────────┼────────────────────────────────────────┼────────┼──────────────────────┤
  │ 0      │ This contract outlines the terms...    │ 380    │ 10:30:35 AM          │
  │ 1      │ The parties agree to the following...  │ 420    │ 10:30:36 AM          │
  │ 2      │ Payment terms shall be as follows...   │ 290    │ 10:30:37 AM          │
  │ ...    │ ...                                    │ ...    │ ...                  │
  └────────┴────────────────────────────────────────┴────────┴──────────────────────┘

📊 Pipeline Status Summary:
  Processing Time: 23s
  DynamoDB Status: PROCESSED
  Overall Pipeline: FULLY_PROCESSED
```

**Pipeline Verification Features:**
- ✅ **DynamoDB Metadata**: Document record and processing status
- ✅ **S3 Storage**: File existence, size, timestamps, content preview
- ✅ **PostgreSQL Metadata**: Document tracking in vector database
- ✅ **Embeddings Analysis**: Chunk count, content length, creation times
- ✅ **Chunk Details**: Individual chunk previews (for ≤10 chunks)
- ✅ **Overall Health**: End-to-end pipeline status verification

### Delete Document

```bash
ragtime delete abc-123-def-456
```

Output:
```
Document abc-123-def-456 deleted successfully
```

## Upload Options

The upload command supports three methods:

1. **File Upload**: Pass a file path
   ```bash
   ragtime upload /path/to/document.txt
   ragtime upload --file /path/to/document.txt
   ```

2. **String Upload**: Pass text content directly
   ```bash
   ragtime upload "Your text content here" --name filename.txt
   ragtime upload --string "Your text content here" --name filename.txt
   ```

3. **URL Upload**: Download and upload content from URL
   ```bash
   ragtime upload https://example.com/document.txt
   ragtime upload --url https://example.com/document.txt --name custom-name.txt
   ```

## Troubleshooting

### Authentication Issues
- Ensure AWS credentials are configured (`aws configure` or environment variables)
- Check that your AWS profile has permissions to access API Gateway and the RagTime APIs

### API Discovery Issues
- Set `RAGTIME_API_URL` environment variable if auto-discovery fails
- Verify the API Gateway exists and is deployed

### Upload Failures
- Check file exists and is readable
- Verify file size is under 50MB limit
- For URLs, ensure the content is accessible and text-based

### Command Not Found
- Run `npm run build` in the cli directory
- Use `./dist/index.js` directly if not globally linked
- Or run with `npx ts-node src/index.ts` for development

## API Requirements

The CLI expects these API endpoints to be available:

- `POST /documents` - Upload documents
- `GET /documents` - List documents
- `GET /documents/{id}` - Get document details  
- `GET /documents/{id}/analysis` - Get comprehensive pipeline analysis (PostgreSQL + embeddings data)
- `DELETE /documents/{id}` - Delete document

All endpoints require `tenant_id` parameter.

**Note**: The `/documents/{id}/analysis` endpoint is used by the `--status` flag to perform comprehensive pipeline verification. This endpoint should be implemented by a Lambda function with VPC access to query the PostgreSQL database for embeddings and chunk data.
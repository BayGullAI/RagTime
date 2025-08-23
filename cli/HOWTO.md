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
Document: abc-123-def-456
Name: contract.pdf
Status: PROCESSED
Size: 2.00MB
Uploaded: 1/15/2024, 10:30:25 AM
Content Type: application/pdf
Word Count: 1250
```

### Check Processing Status

```bash
ragtime get abc-123-def-456 --status
```

Example output:
```
Document: contract.pdf (abc-123-def-456)
Status: PROCESSED
Words: 1250
Processing time: 23s
```

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
- `DELETE /documents/{id}` - Delete document

All endpoints require `tenant_id` parameter.
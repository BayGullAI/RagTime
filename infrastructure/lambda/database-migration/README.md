# Database Migration Lambda

This directory contains the Lambda function responsible for database schema migrations.

## Architecture

- **Single Source of Truth**: `infrastructure/backend/src/migrations/` contains ALL SQL migration files
- **No Duplication**: This directory contains ONLY the Lambda function code
- **CDK Asset System**: Points directly to the source directory for S3 uploads

## Migration Files Location

- ✅ **Source**: `/infrastructure/backend/src/migrations/*.sql`
- ❌ **NOT HERE**: No SQL files should exist in this Lambda directory

## How it Works

1. **CDK Build**: Uploads SQL files from source directory to S3 as assets
2. **Lambda Runtime**: Reads migrations from S3 at runtime
3. **No Duplication**: Zero file copies needed - CDK handles S3 upload directly

## Adding New Migrations

1. Create new `.sql` file in `/infrastructure/backend/src/migrations/`
2. Deploy with CDK - no manual copying required
3. Lambda will automatically discover and apply new migrations
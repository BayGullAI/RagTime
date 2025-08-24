# Database Migration Lambda

This directory contains the Lambda function responsible for database schema migrations.

## Migration Files

The SQL migration files in this directory are **COPIES** from the source directory:
- **Source of Truth**: `infrastructure/backend/src/migrations/`
- **Build Copies**: `infrastructure/lambda/database-migration/` (this directory)

**Important**: Do not edit SQL files directly in this directory. Edit them in the source directory and copy them here during build.

## Build Process

Before deploying, copy the latest migrations:
```bash
cp infrastructure/backend/src/migrations/*.sql infrastructure/lambda/database-migration/
```

## How it Works

1. **S3 Asset System**: CDK uploads all `.sql` files from this directory to S3
2. **Lambda Runtime**: Function attempts to read from S3 first, falls back to bundled files
3. **Single Source of Truth**: All migrations originate from `infrastructure/backend/src/migrations/`
import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { getApiClient, formatStatus, handleError } from '../utils';
import { verifyS3Object, getS3ObjectPreview } from '../s3-service';

export const getCommand = new Command('get')
  .description('Get comprehensive document analysis')
  .argument('<document-id>', 'Document ID to retrieve')
  .option('-s, --status', 'Show detailed pipeline status verification')
  .action(async (documentId, options) => {
    try {
      const client = await getApiClient();
      
      console.log(chalk.blue(`🔍 Analyzing document: ${documentId}\n`));
      
      // 1. Get DynamoDB metadata
      console.log(chalk.cyan('📊 DynamoDB Metadata:'));
      const doc = await client.getDocument(documentId);
      console.log(`  Document ID: ${chalk.yellow(doc.asset_id)}`);
      console.log(`  Filename: ${doc.file_name}`);
      console.log(`  Status: ${formatStatus(doc.status)}`);
      console.log(`  Size: ${(doc.file_size / 1024).toFixed(1)}KB`);
      console.log(`  Content Type: ${doc.content_type}`);
      console.log(`  Created: ${new Date(doc.created_at).toLocaleString()}`);
      console.log(`  Updated: ${new Date(doc.updated_at).toLocaleString()}`);
      if (doc.error_message) {
        console.log(`  Error: ${chalk.red(doc.error_message)}`);
      }
      
      // Always show processing details - get database analysis through API Gateway -> Lambda
      console.log('\n' + chalk.cyan('🔧 Processing Details:'));
      
      try {
        const analysis = await client.getDocumentAnalysis(documentId);
        
        const pgData = analysis.postgresql;
        const embData = analysis.embeddings;
        
        if (pgData && pgData.exists) {
          console.log(`  Total Chunks: ${chalk.yellow(pgData.total_chunks || 0)}`);
          console.log(`  PostgreSQL Status: ${formatStatus(pgData.status || 'UNKNOWN')}`);
          if (pgData.correlation_id) {
            console.log(`  Correlation ID: ${pgData.correlation_id}`);
          }
        } else {
          console.log(`  ${chalk.red('⚠️  No processing details found in PostgreSQL')}`);
        }

        if (embData && embData.total_embeddings > 0) {
          console.log(`  Embeddings Generated: ${chalk.green(embData.total_embeddings)}`);
          if (embData.embedding_model) {
            console.log(`  Embedding Model: ${embData.embedding_model}`);
          }
          if (embData.processing_stage) {
            console.log(`  Processing Stage: ${embData.processing_stage}`);
          }
        } else {
          console.log(`  ${chalk.red('⚠️  No embeddings found - processing may have failed')}`);
        }

        // Processing steps completed (based on available data)
        const stepsCompleted = [];
        if (pgData?.total_chunks > 0) stepsCompleted.push("Text Chunking");
        if (embData?.total_embeddings > 0) stepsCompleted.push("Embeddings Generation");
        if (pgData?.status === 'completed') stepsCompleted.push("Database Storage");
        if (doc.status === 'PROCESSED') stepsCompleted.push("Status Update");
        
        if (stepsCompleted.length > 0) {
          console.log(`  Steps Completed: ${chalk.green(stepsCompleted.join(', '))}`);
        }
        
      } catch (error: any) {
        console.log(`  ${chalk.red('⚠️  Could not retrieve processing details')}`);
        console.log(`  Error: ${error.message}`);
      }

      if (!options.status) {
        // Simple view stops here
        return;
      }

      console.log('\n' + chalk.cyan('🗄️ S3 Storage Verification:'));
      
      // 2. Verify S3 storage (extract from DynamoDB data)
      if (doc.s3_bucket && doc.s3_key) {
        const s3Info = await verifyS3Object(doc.s3_bucket, doc.s3_key);
        if (s3Info.exists) {
          console.log(`  ✅ S3 Object: ${chalk.green('EXISTS')}`);
          console.log(`  Bucket: ${doc.s3_bucket}`);
          console.log(`  Key: ${doc.s3_key}`);
          console.log(`  S3 Size: ${s3Info.size ? (s3Info.size / 1024).toFixed(1) + 'KB' : 'Unknown'}`);
          console.log(`  Last Modified: ${s3Info.lastModified?.toLocaleString() || 'Unknown'}`);
          console.log(`  Content Type: ${s3Info.contentType || 'Unknown'}`);
          
          // Get content preview
          const preview = await getS3ObjectPreview(doc.s3_bucket, doc.s3_key, 100);
          if (preview) {
            console.log(`  Preview: ${chalk.gray('"' + preview + '"')}`);
          }
        } else {
          console.log(`  ❌ S3 Object: ${chalk.red('NOT FOUND')}`);
          console.log(`  Error: ${s3Info.error}`);
        }
      } else {
        console.log(`  ❌ S3 Info: ${chalk.red('MISSING from DynamoDB')}`);
      }

      console.log('\n' + chalk.cyan('🗃️ Database Analysis via API:'));
      
      // 3. Get database analysis through API Gateway -> Lambda
      try {
        const analysis = await client.getDocumentAnalysis(documentId);
        
        if (analysis.postgresql) {
          const pgData = analysis.postgresql;
          if (pgData.exists) {
            console.log(`  ✅ Document Record: ${chalk.green('EXISTS')}`);
            console.log(`  Original Filename: ${pgData.original_filename || 'Unknown'}`);
            console.log(`  Content Type: ${pgData.content_type || 'Unknown'}`);
            console.log(`  File Size: ${pgData.file_size ? (pgData.file_size / 1024).toFixed(1) + 'KB' : 'Unknown'}`);
            console.log(`  Total Chunks: ${pgData.total_chunks || 0}`);
            console.log(`  PG Status: ${formatStatus(pgData.status || 'UNKNOWN')}`);
            if (pgData.error_message) {
              console.log(`  PG Error: ${chalk.red(pgData.error_message)}`);
            }
            console.log(`  PG Created: ${pgData.created_at ? new Date(pgData.created_at).toLocaleString() : 'Unknown'}`);
          } else {
            console.log(`  ❌ Document Record: ${chalk.red('NOT FOUND')}`);
          }
        } else {
          console.log(`  ❌ PostgreSQL Query: ${chalk.red('NO DATA')}`);
        }

        console.log('\n' + chalk.cyan('🧩 Embeddings & Chunks Analysis:'));
        
        if (analysis.embeddings) {
          const embData = analysis.embeddings;
          if (embData.total_embeddings > 0) {
            console.log(`  ✅ Embeddings: ${chalk.green(`${embData.total_embeddings} FOUND`)}`);
            console.log(`  Unique Chunks: ${embData.unique_chunks || 0}`);
            console.log(`  Avg Content Length: ${embData.avg_content_length ? Math.round(embData.avg_content_length) : 0} characters`);
            console.log(`  First Embedding: ${embData.first_embedding ? new Date(embData.first_embedding).toLocaleString() : 'Unknown'}`);
            console.log(`  Last Embedding: ${embData.last_embedding ? new Date(embData.last_embedding).toLocaleString() : 'Unknown'}`);
            
            // Show embedding details table if available
            if (embData.chunks && embData.chunks.length <= 10) {
              console.log('\n  📋 Chunk Details:');
              const table = new Table({
                head: ['Index', 'Content Preview', 'Length', 'Created'],
                colWidths: [8, 40, 10, 20]
              });
              
              embData.chunks.forEach((chunk: any) => {
                const preview = chunk.content && chunk.content.length > 35 ? 
                  chunk.content.substring(0, 35) + '...' : chunk.content || '';
                table.push([
                  chunk.chunk_index || 0,
                  preview,
                  chunk.content ? chunk.content.length : 0,
                  chunk.created_at ? new Date(chunk.created_at).toLocaleTimeString() : 'Unknown'
                ]);
              });
              
              console.log(table.toString());
            } else if (embData.total_embeddings > 10) {
              console.log(`  📋 ${embData.total_embeddings} chunks (too many to display individually)`);
            }
          } else {
            console.log(`  ❌ Embeddings: ${chalk.red('NONE FOUND')}`);
          }
        } else {
          console.log(`  ❌ Embedding Query: ${chalk.red('NO DATA')}`);
        }
        // 5. Pipeline Status Summary
        console.log('\n' + chalk.cyan('📊 Pipeline Status Summary:'));
        const uploadTime = new Date(doc.created_at).getTime();
        const updateTime = new Date(doc.updated_at).getTime();
        const processingTime = updateTime > uploadTime ? Math.round((updateTime - uploadTime) / 1000) : 0;
        
        console.log(`  Processing Time: ${processingTime}s`);
        console.log(`  DynamoDB Status: ${formatStatus(doc.status)}`);
        
        // Overall pipeline health from API analysis
        const s3Info = doc.s3_bucket && doc.s3_key ? await verifyS3Object(doc.s3_bucket, doc.s3_key) : { exists: false };
        const hasEmbeddings = analysis.embeddings && analysis.embeddings.total_embeddings > 0;
        
        let pipelineStatus = 'INCOMPLETE';
        if (doc.status === 'PROCESSED' && s3Info.exists && hasEmbeddings) {
          pipelineStatus = 'FULLY_PROCESSED';
        } else if (doc.status === 'FAILED') {
          pipelineStatus = 'FAILED';
        }
        
        console.log(`  Overall Pipeline: ${formatStatus(pipelineStatus)}`);
        
      } catch (error: any) {
        console.log(`  ❌ Database Analysis API: ${chalk.red('FAILED')}`);
        console.log(`  Error: ${error.message}`);
        
        // Fallback message for missing endpoint
        if (error.response?.status === 404) {
          console.log(`  💡 Note: Database analysis endpoint not yet implemented in API`);
        }
        
        // Fallback Pipeline Status Summary without analysis data
        console.log('\n' + chalk.cyan('📊 Pipeline Status Summary:'));
        const uploadTime = new Date(doc.created_at).getTime();
        const updateTime = new Date(doc.updated_at).getTime();
        const processingTime = updateTime > uploadTime ? Math.round((updateTime - uploadTime) / 1000) : 0;
        
        console.log(`  Processing Time: ${processingTime}s`);
        console.log(`  DynamoDB Status: ${formatStatus(doc.status)}`);
        console.log(`  Overall Pipeline: ${formatStatus('UNKNOWN')}`);
      }
      
    } catch (error: any) {
      handleError(error, 'Get');
    }
  });
import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { getApiClient, formatStatus, handleError } from '../utils';
import { getDocumentEmbeddings, getDocumentMetadata, getEmbeddingStats, closeDatabaseConnection } from '../database';
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
      if (doc.word_count) {
        console.log(`  Word Count: ${doc.word_count}`);
      }
      if (doc.error_message) {
        console.log(`  Error: ${chalk.red(doc.error_message)}`);
      }
      
      if (!options.status) {
        // Simple view, just show DynamoDB data
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

      console.log('\n' + chalk.cyan('🗃️ PostgreSQL Metadata:'));
      
      // 3. Check PostgreSQL documents table
      try {
        const pgDoc = await getDocumentMetadata(documentId);
        if (pgDoc) {
          console.log(`  ✅ Document Record: ${chalk.green('EXISTS')}`);
          console.log(`  Original Filename: ${pgDoc.original_filename}`);
          console.log(`  Content Type: ${pgDoc.content_type || 'Unknown'}`);
          console.log(`  File Size: ${pgDoc.file_size ? (pgDoc.file_size / 1024).toFixed(1) + 'KB' : 'Unknown'}`);
          console.log(`  Total Chunks: ${pgDoc.total_chunks || 0}`);
          console.log(`  PG Status: ${formatStatus(pgDoc.status)}`);
          if (pgDoc.error_message) {
            console.log(`  PG Error: ${chalk.red(pgDoc.error_message)}`);
          }
          console.log(`  PG Created: ${new Date(pgDoc.created_at).toLocaleString()}`);
        } else {
          console.log(`  ❌ Document Record: ${chalk.red('NOT FOUND')}`);
        }
      } catch (error: any) {
        console.log(`  ❌ PostgreSQL Connection: ${chalk.red('FAILED')}`);
        console.log(`  Error: ${error.message}`);
      }

      console.log('\n' + chalk.cyan('🧩 Embeddings & Chunks Analysis:'));
      
      // 4. Check embeddings in pgvector
      try {
        const embeddings = await getDocumentEmbeddings(documentId);
        const stats = await getEmbeddingStats(documentId);
        
        if (embeddings.length > 0) {
          console.log(`  ✅ Embeddings: ${chalk.green(`${stats.totalEmbeddings} FOUND`)}`);
          console.log(`  Unique Chunks: ${stats.uniqueChunks}`);
          console.log(`  Avg Content Length: ${stats.avgContentLength.toFixed(0)} characters`);
          console.log(`  First Embedding: ${stats.firstEmbedding ? new Date(stats.firstEmbedding).toLocaleString() : 'Unknown'}`);
          console.log(`  Last Embedding: ${stats.lastEmbedding ? new Date(stats.lastEmbedding).toLocaleString() : 'Unknown'}`);
          
          // Show embedding details table
          if (embeddings.length <= 10) {
            console.log('\n  📋 Chunk Details:');
            const table = new Table({
              head: ['Index', 'Content Preview', 'Length', 'Created'],
              colWidths: [8, 40, 10, 20]
            });
            
            embeddings.forEach(emb => {
              const preview = emb.content.length > 35 ? 
                emb.content.substring(0, 35) + '...' : emb.content;
              table.push([
                emb.chunk_index,
                preview,
                emb.content.length,
                new Date(emb.created_at).toLocaleTimeString()
              ]);
            });
            
            console.log(table.toString());
          } else {
            console.log(`  📋 ${embeddings.length} chunks (too many to display individually)`);
          }
        } else {
          console.log(`  ❌ Embeddings: ${chalk.red('NONE FOUND')}`);
        }
      } catch (error: any) {
        console.log(`  ❌ Embedding Query: ${chalk.red('FAILED')}`);
        console.log(`  Error: ${error.message}`);
      }

      // 5. Pipeline Status Summary
      console.log('\n' + chalk.cyan('📊 Pipeline Status Summary:'));
      const uploadTime = new Date(doc.created_at).getTime();
      const updateTime = new Date(doc.updated_at).getTime();
      const processingTime = updateTime > uploadTime ? Math.round((updateTime - uploadTime) / 1000) : 0;
      
      console.log(`  Processing Time: ${processingTime}s`);
      console.log(`  DynamoDB Status: ${formatStatus(doc.status)}`);
      
      // Overall pipeline health
      const s3Info = doc.s3_bucket && doc.s3_key ? await verifyS3Object(doc.s3_bucket, doc.s3_key) : { exists: false };
      const hasEmbeddings = (await getEmbeddingStats(documentId)).totalEmbeddings > 0;
      
      let pipelineStatus = 'INCOMPLETE';
      if (doc.status === 'PROCESSED' && s3Info.exists && hasEmbeddings) {
        pipelineStatus = 'FULLY_PROCESSED';
      } else if (doc.status === 'FAILED') {
        pipelineStatus = 'FAILED';
      }
      
      console.log(`  Overall Pipeline: ${formatStatus(pipelineStatus)}`);
      
      // Close database connection
      await closeDatabaseConnection();
      
    } catch (error: any) {
      await closeDatabaseConnection();
      handleError(error, 'Get');
    }
  });
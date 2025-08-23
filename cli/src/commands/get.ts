import { Command } from 'commander';
import chalk from 'chalk';
import { getApiClient, formatStatus, handleError } from '../utils';

export const getCommand = new Command('get')
  .description('Get document details')
  .argument('<document-id>', 'Document ID to retrieve')
  .option('-s, --status', 'Show processing status and time')
  .action(async (documentId, options) => {
    try {
      const client = await getApiClient();
      const doc = await client.getDocument(documentId);
      
      if (options.status) {
        // Status view (merged from status command)
        console.log(`Document: ${doc.file_name} (${chalk.yellow(doc.asset_id)})`);
        console.log(`Status: ${formatStatus(doc.status)}`);
        
        if (doc.word_count) {
          console.log(`Words: ${doc.word_count}`);
        }
        
        const uploadTime = new Date(doc.created_at).getTime();
        const updateTime = new Date(doc.updated_at).getTime();
        if (updateTime > uploadTime) {
          const processingTime = Math.round((updateTime - uploadTime) / 1000);
          console.log(`Processing time: ${processingTime}s`);
        }
        
        if (doc.error_message) {
          console.log(`Error: ${chalk.red(doc.error_message)}`);
        }
      } else {
        // Full details view
        console.log(`Document: ${chalk.yellow(doc.asset_id)}`);
        console.log(`Name: ${doc.file_name}`);
        console.log(`Status: ${formatStatus(doc.status)}`);
        console.log(`Size: ${(doc.file_size / 1024 / 1024).toFixed(2)}MB`);
        console.log(`Uploaded: ${new Date(doc.created_at).toLocaleString()}`);
        console.log(`Content Type: ${doc.content_type}`);
        
        if (doc.word_count) {
          console.log(`Word Count: ${doc.word_count}`);
        }
        
        if (doc.error_message) {
          console.log(`Error: ${chalk.red(doc.error_message)}`);
        }
      }
      
    } catch (error: any) {
      handleError(error, 'Get');
    }
  });
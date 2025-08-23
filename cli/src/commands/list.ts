import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { getApiClient, formatStatus, handleError } from '../utils';

export const listCommand = new Command('list')
  .description('List all documents')
  .action(async () => {
    try {
      const client = await getApiClient();
      const response = await client.listDocuments();
      
      if (response.documents.length === 0) {
        console.log(chalk.yellow('No documents found.'));
        return;
      }
      
      const table = new Table({
        head: ['ID', 'NAME', 'STATUS', 'UPLOADED', 'SIZE'],
        colWidths: [15, 25, 12, 20, 10]
      });
      
      response.documents.forEach(doc => {
        const sizeKB = (doc.file_size / 1024).toFixed(1);
        const uploadDate = new Date(doc.created_at).toLocaleString();
        
        table.push([
          doc.asset_id.substring(0, 12) + '...',
          doc.file_name,
          formatStatus(doc.status),
          uploadDate,
          `${sizeKB}KB`
        ]);
      });
      
      console.log(table.toString());
      console.log(`\nTotal: ${response.documents.length} documents`);
      
    } catch (error: any) {
      handleError(error, 'List');
    }
  });
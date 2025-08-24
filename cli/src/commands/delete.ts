import { Command } from 'commander';
import chalk from 'chalk';
import { getApiClient, handleError } from '../utils';

export const deleteCommand = new Command('delete')
  .description('Delete a document')
  .argument('<document-id>', 'Document ID to delete')
  .action(async (documentId) => {
    try {
      const client = await getApiClient();
      await client.deleteDocument(documentId);
      console.log(chalk.green(`Document ${documentId} deleted successfully`));
    } catch (error: any) {
      handleError(error, 'Delete');
    }
  });
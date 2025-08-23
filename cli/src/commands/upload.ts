import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { extname } from 'path';
import chalk from 'chalk';
import { getApiClient, handleError } from '../utils';

export const uploadCommand = new Command('upload')
  .description('Upload a document')
  .argument('[input]', 'File path, URL, or text content to upload')
  .option('-f, --file <path>', 'Upload from file path')
  .option('-s, --string <text>', 'Upload text content directly')
  .option('-u, --url <url>', 'Upload content from URL')
  .option('-n, --name <name>', 'Custom filename for string/URL content')
  .action(async (input, options) => {
    try {
      const client = await getApiClient();
      let result;
      
      if (options.file || (input && existsSync(input))) {
        // Upload file
        const filePath = options.file || input;
        console.log(chalk.blue(`Uploading file: ${filePath}...`));
        const content = readFileSync(filePath);
        
        // Improved content type detection
        const ext = extname(filePath).toLowerCase();
        const contentType = ext === '.pdf' ? 'application/pdf' :
                           ext === '.json' ? 'application/json' :
                           ext === '.csv' ? 'text/csv' : 'text/plain';
        
        result = await client.uploadFile(filePath, content, contentType);
        
      } else if (options.string || (input && !input.startsWith('http'))) {
        // Upload string
        const text = options.string || input;
        const filename = options.name || 'text-content.txt';
        console.log(chalk.blue(`Uploading text content as: ${filename}...`));
        result = await client.uploadString(text, filename);
        
      } else if (options.url || (input && input.startsWith('http'))) {
        // Upload URL
        const url = options.url || input;
        console.log(chalk.blue(`Uploading content from URL: ${url}...`));
        result = await client.uploadUrl(url);
        
      } else {
        console.error(chalk.red('Error: No input provided. Use --file, --string, --url, or provide a file path/URL/text as argument.'));
        process.exit(1);
      }
      
      console.log(chalk.green('✓ Upload complete'));
      console.log(`Document ID: ${chalk.yellow(result.asset_id)}`);
      console.log(`Status: ${chalk.cyan(result.status)}`);
      console.log(`Filename: ${result.file_name}`);
      console.log(`Size: ${(result.file_size / 1024).toFixed(1)}KB`);
      
    } catch (error: any) {
      handleError(error, 'Upload');
    }
  });
import chalk from 'chalk';
import { ApiClient, Document } from './api';
import { getConfig } from './config';

let cachedClient: ApiClient | null = null;

export async function getApiClient(): Promise<ApiClient> {
  if (!cachedClient) {
    const config = await getConfig();
    cachedClient = new ApiClient(config);
  }
  return cachedClient;
}

export function formatStatus(status: Document['status']): string {
  switch (status) {
    case 'PROCESSED':
      return chalk.green(status);
    case 'FAILED':
      return chalk.red(status);
    default:
      return chalk.yellow(status);
  }
}

export function handleError(error: any, operation: string): never {
  if (error.response?.status === 404) {
    console.error(chalk.red('Document not found'));
  } else {
    console.error(chalk.red(`${operation} failed:`), error.message);
  }
  process.exit(1);
}
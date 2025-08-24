/**
 * Database abstraction interface for dependency injection
 */

export interface IDatabaseClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  query(text: string, params?: any[]): Promise<any>;
  transaction<T>(callback: (client: IDatabaseClient) => Promise<T>): Promise<T>;
}

export interface DatabaseCredentials {
  username: string;
  password: string;
}
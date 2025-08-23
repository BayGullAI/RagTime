import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import { Config } from './config';

export interface Document {
  tenant_id: string;
  asset_id: string;
  file_name: string;
  file_size: number;
  content_type: string;
  status: 'UPLOADED' | 'PROCESSED' | 'FAILED';
  created_at: string;
  updated_at: string;
  error_message?: string;
  word_count?: number;
}

export interface ListResponse {
  documents: Document[];
  next_token?: string;
  total_count?: number;
}

export class ApiClient {
  private client: AxiosInstance;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.client = axios.create({
      baseURL: config.apiBaseUrl,
      timeout: 60000,
    });
  }

  async uploadFile(filePath: string, content: Buffer, contentType: string): Promise<Document> {
    const form = new FormData();
    form.append('file', content, { filename: filePath, contentType });
    form.append('tenant_id', this.config.tenantId);

    const response = await this.client.post('/documents', form, {
      headers: form.getHeaders(),
    });

    return response.data.document;
  }

  async uploadString(content: string, filename: string): Promise<Document> {
    const buffer = Buffer.from(content, 'utf8');
    return this.uploadFile(filename, buffer, 'text/plain');
  }

  async uploadUrl(url: string): Promise<Document> {
    const response = await axios.get(url);
    const content = Buffer.from(response.data, 'utf8');
    const filename = url.split('/').pop() || 'url-content.txt';
    return this.uploadFile(filename, content, 'text/plain');
  }

  async listDocuments(): Promise<ListResponse> {
    const response = await this.client.get('/documents', {
      params: { tenant_id: this.config.tenantId },
    });
    return response.data;
  }

  async getDocument(assetId: string): Promise<Document> {
    const response = await this.client.get(`/documents/${assetId}`, {
      params: { tenant_id: this.config.tenantId },
    });
    return response.data.document;
  }

  async deleteDocument(assetId: string): Promise<void> {
    await this.client.delete(`/documents/${assetId}`, {
      params: { tenant_id: this.config.tenantId },
    });
  }
}
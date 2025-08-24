/**
 * Composition root for dependency injection setup
 * This is where all services are wired together
 */

import { ServiceContainer, ServiceTokens } from './service-container';
import { DatabaseClient } from '../lib/database';
import { OpenAIService } from '../services/openai.service';
import { DocumentService } from '../services/document.service';
import { TextProcessingService } from '../services/text-processing.service';
import { ErrorHandlerService } from '../services/error-handler.service';
import { DocumentUploadService } from '../services/document-upload.service';
import { IDatabaseClient } from '../interfaces/database.interface';
import { IOpenAIService } from '../interfaces/openai.interface';
import { IDocumentService } from '../interfaces/document.interface';
import { ITextProcessingService } from '../interfaces/text-processing.interface';
import { ErrorHandler } from '../interfaces/error-handler.interface';
import { IDocumentUploadService } from '../interfaces/document-upload.interface';
import { initializeLogger } from '../utils/structured-logger';

export class CompositionRoot {
  private static container: ServiceContainer | null = null;

  /**
   * Get the configured service container
   */
  static getContainer(): ServiceContainer {
    if (!this.container) {
      this.container = this.createContainer();
    }
    return this.container;
  }

  /**
   * Create and configure the service container
   */
  private static createContainer(): ServiceContainer {
    const container = new ServiceContainer();

    // Register database client as singleton
    container.register<IDatabaseClient>(
      ServiceTokens.DATABASE_CLIENT,
      () => new DatabaseClient(),
      'singleton'
    );

    // Register OpenAI service as singleton
    container.register<IOpenAIService>(
      ServiceTokens.OPENAI_SERVICE,
      () => new OpenAIService(),
      'singleton'
    );

    // Register document service as singleton with injected database client
    container.register<IDocumentService>(
      ServiceTokens.DOCUMENT_SERVICE,
      (container) => new DocumentService(
        container.resolve<IDatabaseClient>(ServiceTokens.DATABASE_CLIENT)
      ),
      'singleton'
    );

    // Register text processing service as singleton with injected dependencies
    container.register<ITextProcessingService>(
      ServiceTokens.TEXT_PROCESSING_SERVICE,
      (container) => new TextProcessingService(
        container.resolve<IOpenAIService>(ServiceTokens.OPENAI_SERVICE),
        container.resolve<IDocumentService>(ServiceTokens.DOCUMENT_SERVICE)
      ),
      'singleton'
    );

    // Register error handler as singleton with logger
    container.register<ErrorHandler>(
      ServiceTokens.ERROR_HANDLER,
      () => {
        // Create a default logger for error handling (will use correlation ID from context)
        const logger = initializeLogger({ httpMethod: 'N/A', headers: {} }, 'error-handler');
        return new ErrorHandlerService(logger);
      },
      'singleton'
    );

    // Register document upload service as transient with logger
    container.register<IDocumentUploadService>(
      ServiceTokens.DOCUMENT_UPLOAD_SERVICE,
      () => {
        // Create a default logger for document upload service
        const logger = initializeLogger({ httpMethod: 'POST', headers: {} }, 'document-upload-service');
        return new DocumentUploadService(logger);
      },
      'transient' // Transient to get fresh logger instance per request
    );

    return container;
  }

  /**
   * Clear the container (for testing)
   */
  static clearContainer(): void {
    this.container = null;
  }
}
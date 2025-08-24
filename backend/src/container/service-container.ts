/**
 * Simple service container for dependency injection
 */

type ServiceFactory<T = any> = (container: ServiceContainer) => T;
type ServiceLifetime = 'singleton' | 'transient';

interface ServiceRegistration<T = any> {
  factory: ServiceFactory<T>;
  lifetime: ServiceLifetime;
  instance?: T;
}

export class ServiceContainer {
  private services = new Map<string, ServiceRegistration>();

  /**
   * Register a service with the container
   */
  register<T>(
    token: string,
    factory: ServiceFactory<T>,
    lifetime: ServiceLifetime = 'singleton'
  ): void {
    this.services.set(token, { factory, lifetime });
  }

  /**
   * Resolve a service from the container
   */
  resolve<T>(token: string): T {
    const registration = this.services.get(token);
    if (!registration) {
      throw new Error(`Service '${token}' not registered`);
    }

    // Return singleton instance if already created
    if (registration.lifetime === 'singleton' && registration.instance) {
      return registration.instance as T;
    }

    // Create new instance
    const instance = registration.factory(this);

    // Store singleton instance
    if (registration.lifetime === 'singleton') {
      registration.instance = instance;
    }

    return instance as T;
  }

  /**
   * Check if a service is registered
   */
  isRegistered(token: string): boolean {
    return this.services.has(token);
  }

  /**
   * Clear all registrations (useful for testing)
   */
  clear(): void {
    this.services.clear();
  }
}

// Service tokens (string constants to avoid typos)
export const ServiceTokens = {
  DATABASE_CLIENT: 'IDatabaseClient',
  OPENAI_SERVICE: 'IOpenAIService',
  DOCUMENT_SERVICE: 'IDocumentService', 
  TEXT_PROCESSING_SERVICE: 'ITextProcessingService',
  ERROR_HANDLER: 'IErrorHandler',
  DOCUMENT_UPLOAD_SERVICE: 'IDocumentUploadService'
} as const;
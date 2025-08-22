import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { VectorDatabase, testConnection, query } from '../../lib/database';

/**
 * Generate random embedding vector for testing
 */
function generateRandomEmbedding(dimensions: number = 1024): number[] {
  return Array(dimensions).fill(0).map(() => Math.random() * 2 - 1); // Random values between -1 and 1
}

/**
 * Create response with CORS headers
 */
function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

/**
 * Test database connection
 */
async function handleConnectionTest(): Promise<APIGatewayProxyResult> {
  try {
    await testConnection();
    
    // Test pgvector extension
    const vectorResult = await query("SELECT '1,2,3'::vector as test_vector");
    
    // Test table existence
    const tablesResult = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('document_embeddings', 'documents', 'schema_migrations')
      ORDER BY table_name
    `);

    return createResponse(200, {
      message: 'Database connection successful',
      postgresqlVersion: vectorResult[0]?.test_vector ? 'pgvector extension working' : 'pgvector test failed',
      tables: tablesResult.map(row => row.table_name),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Connection test failed:', error);
    return createResponse(500, {
      error: 'Database connection failed',
      message: (error as Error).message,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Test vector operations - insert sample data
 */
async function handleVectorInsertTest(): Promise<APIGatewayProxyResult> {
  try {
    const documentId = `test-doc-${Date.now()}`;
    
    // Generate sample chunks with embeddings
    const chunks = [
      {
        chunkIndex: 0,
        content: 'This is the first chunk of a test document about artificial intelligence and machine learning.',
        embedding: generateRandomEmbedding(),
        metadata: { type: 'introduction', section: 'overview' }
      },
      {
        chunkIndex: 1,
        content: 'Vector databases are essential for storing and searching high-dimensional data efficiently.',
        embedding: generateRandomEmbedding(),
        metadata: { type: 'content', section: 'technology' }
      },
      {
        chunkIndex: 2,
        content: 'Aurora PostgreSQL with pgvector provides excellent vector search capabilities.',
        embedding: generateRandomEmbedding(),
        metadata: { type: 'content', section: 'implementation' }
      }
    ];

    // Insert embeddings
    await VectorDatabase.insertEmbeddings(documentId, chunks);

    // Get document stats
    const stats = await VectorDatabase.getDocumentStats(documentId);

    return createResponse(200, {
      message: 'Vector insert test successful',
      documentId,
      chunksInserted: chunks.length,
      documentStats: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Vector insert test failed:', error);
    return createResponse(500, {
      error: 'Vector insert test failed',
      message: (error as Error).message,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Test vector similarity search
 */
async function handleSimilaritySearchTest(): Promise<APIGatewayProxyResult> {
  try {
    // Generate a query embedding
    const queryEmbedding = generateRandomEmbedding();
    
    // Perform similarity search
    const results = await VectorDatabase.similaritySearch(queryEmbedding, 5, 0.0);

    return createResponse(200, {
      message: 'Similarity search test successful',
      queryDimensions: queryEmbedding.length,
      resultsFound: results.length,
      results: results.map(r => ({
        documentId: r.documentId,
        chunkIndex: r.chunkIndex,
        content: r.content.substring(0, 100) + '...',
        distance: r.distance,
        metadata: r.metadata
      })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Similarity search test failed:', error);
    return createResponse(500, {
      error: 'Similarity search test failed',
      message: (error as Error).message,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * List all documents in the database
 */
async function handleListDocuments(): Promise<APIGatewayProxyResult> {
  try {
    const documents = await VectorDatabase.listDocuments();

    return createResponse(200, {
      message: 'Document listing successful',
      documentsCount: documents.length,
      documents: documents.map(doc => ({
        documentId: doc.documentId,
        chunkCount: doc.chunkCount,
        preview: doc.firstChunk,
        createdAt: doc.createdAt
      })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Document listing failed:', error);
    return createResponse(500, {
      error: 'Document listing failed',
      message: (error as Error).message,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Clean up test data
 */
async function handleCleanupTest(): Promise<APIGatewayProxyResult> {
  try {
    // Delete all test documents
    const testDocResults = await query(`
      SELECT DISTINCT document_id 
      FROM document_embeddings 
      WHERE document_id LIKE 'test-doc-%'
    `);

    let deletedCount = 0;
    for (const row of testDocResults) {
      await VectorDatabase.deleteDocument(row.document_id);
      deletedCount++;
    }

    return createResponse(200, {
      message: 'Test data cleanup successful',
      deletedDocuments: deletedCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Test data cleanup failed:', error);
    return createResponse(500, {
      error: 'Test data cleanup failed',
      message: (error as Error).message,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Main Lambda handler
 */
export const handler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> = async (event: APIGatewayProxyEvent) => {
  console.log('Vector test Lambda triggered');
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    const path = event.path || '/';
    const method = event.httpMethod || 'GET';

    console.log(`Handling ${method} ${path}`);

    // Handle different test operations based on path
    switch (path) {
      case '/vector-test/connection':
        return await handleConnectionTest();
      
      case '/vector-test/insert':
        if (method === 'POST') {
          return await handleVectorInsertTest();
        }
        break;
      
      case '/vector-test/search':
        return await handleSimilaritySearchTest();
      
      case '/vector-test/documents':
        return await handleListDocuments();
      
      case '/vector-test/cleanup':
        if (method === 'DELETE') {
          return await handleCleanupTest();
        }
        break;
      
      default:
        // Default test overview
        return createResponse(200, {
          message: 'Vector Test API',
          availableEndpoints: [
            'GET /vector-test/connection - Test database connection',
            'POST /vector-test/insert - Insert test vector data',
            'GET /vector-test/search - Test similarity search',
            'GET /vector-test/documents - List all documents',
            'DELETE /vector-test/cleanup - Clean up test data'
          ],
          timestamp: new Date().toISOString()
        });
    }

    return createResponse(405, {
      error: 'Method not allowed',
      path,
      method,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Vector test Lambda error:', error);
    return createResponse(500, {
      error: 'Internal server error',
      message: (error as Error).message,
      timestamp: new Date().toISOString()
    });
  }
};
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createResponse } from '../../utils/response.utils';
import { TextProcessingService } from '../../services/text-processing.service';
import { OpenAIService } from '../../services/openai.service';

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('Text processing request:', JSON.stringify(event, null, 2));

  try {
    const body = JSON.parse(event.body || '{}');
    const { text, documentId, chunkSize = 1000, chunkOverlap = 200 } = body;

    if (!text || !documentId) {
      return createResponse(400, {
        error: 'Missing required fields: text and documentId'
      });
    }

    // Initialize services
    const openAIService = new OpenAIService();
    const textProcessingService = new TextProcessingService(openAIService);

    // Process the text
    const result = await textProcessingService.processDocument({
      text,
      documentId,
      chunkSize,
      chunkOverlap
    });

    return createResponse(200, {
      message: 'Text processed successfully',
      result
    });

  } catch (error) {
    console.error('Text processing error:', error);
    return createResponse(500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};
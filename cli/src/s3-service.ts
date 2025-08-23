import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

export interface S3ObjectInfo {
  exists: boolean;
  size?: number;
  lastModified?: Date;
  contentType?: string;
  error?: string;
}

export async function verifyS3Object(bucket: string, key: string): Promise<S3ObjectInfo> {
  try {
    const command = new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    const response = await s3Client.send(command);
    
    return {
      exists: true,
      size: response.ContentLength,
      lastModified: response.LastModified,
      contentType: response.ContentType,
    };
  } catch (error: any) {
    return {
      exists: false,
      error: error.name === 'NotFound' ? 'Object not found in S3' : error.message,
    };
  }
}

export async function getS3ObjectPreview(bucket: string, key: string, maxLength: number = 200): Promise<string | null> {
  try {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=0-${maxLength - 1}`,
    });

    const response = await s3Client.send(command);
    if (response.Body) {
      const content = await response.Body.transformToString();
      return content.length > maxLength ? content.substring(0, maxLength) + '...' : content;
    }
    return null;
  } catch (error) {
    return null;
  }
}
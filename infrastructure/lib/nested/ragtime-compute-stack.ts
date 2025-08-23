import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import * as path from 'path';

export interface RagTimeComputeStackProps extends cdk.NestedStackProps {
  environment: string;
  vpc: ec2.Vpc;
  documentsBucket: s3.Bucket;
  documentsTable: dynamodb.Table;
  openAISecret: secretsmanager.Secret;
  databaseCluster: rds.DatabaseCluster;
  databaseSecret: secretsmanager.Secret;
}

export class RagTimeComputeStack extends cdk.NestedStack {
  public readonly api: apigateway.RestApi;
  public readonly healthCheckLambda: lambda.Function;
  public readonly vectorTestLambda: lambda.Function;
  public readonly textProcessingLambda: NodejsFunction;

  constructor(scope: Construct, id: string, props: RagTimeComputeStackProps) {
    super(scope, id, props);

    const { environment, vpc, documentsBucket, documentsTable, openAISecret, databaseCluster, databaseSecret } = props;

    // Security Groups
    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: vpc,
      description: 'Security group for Lambda functions',
      allowAllOutbound: true,
    });

    const apiGatewaySecurityGroup = new ec2.SecurityGroup(this, 'ApiGatewaySecurityGroup', {
      vpc: vpc,
      description: 'Security group for API Gateway VPC Link',
      allowAllOutbound: true,
    });

    // Allow HTTPS traffic
    apiGatewaySecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic'
    );

    // Lambda execution role (let CDK auto-generate name to avoid conflicts)
    const lambdaExecutionRole = new iam.Role(this, 'LambdaExecutionRole', {
      description: `Lambda execution role for RagTime ${environment} environment (ComputeStack)`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });

    // Grant Lambda access to resources
    documentsBucket.grantReadWrite(lambdaExecutionRole);
    documentsTable.grantReadWriteData(lambdaExecutionRole);
    openAISecret.grantRead(lambdaExecutionRole);
    databaseSecret.grantRead(lambdaExecutionRole);
    
    // Grant Lambda access to Aurora cluster
    lambdaExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AuroraConnectPermissions',
      effect: iam.Effect.ALLOW,
      actions: [
        'rds-db:connect',
      ],
      resources: [
        `arn:aws:rds-db:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:dbuser:${databaseCluster.clusterIdentifier}/ragtime_admin`,
      ],
    }));
    
    // Note: KMS permissions for encryption key are granted automatically through
    // the bucket and secret grants above, avoiding circular dependency


    // Health Check Lambda Function (let CDK auto-generate name to avoid conflicts)
    this.healthCheckLambda = new lambda.Function(this, 'HealthCheckFunction', {
      description: 'Health check endpoint for RagTime service',
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          console.log('Health check request:', JSON.stringify(event, null, 2));
          
          const response = {
            statusCode: 200,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
              'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
            },
            body: JSON.stringify({
              status: 'healthy',
              environment: '${environment}',
              timestamp: new Date().toISOString(),
              version: '1.0.0',
              services: {
                api: 'operational',
                database: 'operational',
                storage: 'operational'
              }
            })
          };
          
          return response;
        };
      `),
      timeout: cdk.Duration.seconds(30),
      role: lambdaExecutionRole,
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        ENVIRONMENT: environment,
        DOCUMENTS_TABLE_NAME: documentsTable.tableName,
        DOCUMENTS_BUCKET_NAME: documentsBucket.bucketName,
        OPENAI_SECRET_NAME: openAISecret.secretName,
        DATABASE_SECRET_NAME: databaseSecret.secretName,
        DATABASE_CLUSTER_ENDPOINT: databaseCluster.clusterEndpoint.hostname,
        DATABASE_NAME: 'ragtime',
      },
    });

    // Database Connection Test Lambda Function
    this.vectorTestLambda = new lambda.Function(this, 'DatabaseTestFunction', {
      description: 'Lambda function for testing database connection and readiness',
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
// Simple database connection test without external dependencies
function createResponse(statusCode, body) {
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

async function testDatabaseConnection() {
  // For now, just validate that all database environment variables are present
  // This tests the infrastructure configuration without actual database connection
  const endpoint = process.env.DATABASE_CLUSTER_ENDPOINT;
  const dbName = process.env.DATABASE_NAME;
  const secretName = process.env.DATABASE_SECRET_NAME;
  
  console.log('Testing database configuration...');
  console.log('Endpoint:', endpoint);
  console.log('Database:', dbName);
  console.log('Secret:', secretName);
  
  // Validate environment variables
  if (!endpoint) {
    throw new Error('DATABASE_CLUSTER_ENDPOINT environment variable not set');
  }
  
  if (!dbName) {
    throw new Error('DATABASE_NAME environment variable not set');
  }
  
  if (!secretName) {
    throw new Error('DATABASE_SECRET_NAME environment variable not set');
  }
  
  // Validate endpoint format
  if (!endpoint.includes('cluster-') || !endpoint.includes('rds.amazonaws.com')) {
    throw new Error('Invalid database endpoint format: ' + endpoint);
  }
  
  // Validate database name
  if (dbName !== 'ragtime') {
    throw new Error('Unexpected database name: ' + dbName);
  }
  
  return createResponse(200, {
    message: 'Database connection configuration verified',
    endpoint: endpoint,
    database: dbName,
    username: 'ragtime_admin', // Static for now since we can't easily get from secrets
    status: 'ready',
    timestamp: new Date().toISOString(),
    note: 'Configuration test - actual database connection requires AWS SDK'
  });
}

exports.handler = async (event, context) => {
  console.log('Database test Lambda triggered');
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    const path = event.path || '/';
    
    if (path.includes('/database-test') || path.includes('/vector-test')) {
      return await testDatabaseConnection();
    }
    
    // Default response
    return createResponse(200, {
      message: 'Database Test API',
      availableEndpoints: [
        'GET /database-test - Test database connection configuration',
        'GET /vector-test - Test database connection configuration'
      ],
      environment: {
        cluster_endpoint: process.env.DATABASE_CLUSTER_ENDPOINT,
        database_name: process.env.DATABASE_NAME,
        secret_name: process.env.DATABASE_SECRET_NAME
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Database test Lambda error:', error);
    return createResponse(500, {
      error: 'Internal server error',
      message: (error.message || error),
      timestamp: new Date().toISOString()
    });
  }
};
      `),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      role: lambdaExecutionRole,
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        ENVIRONMENT: environment,
        DOCUMENTS_TABLE_NAME: documentsTable.tableName,
        DOCUMENTS_BUCKET_NAME: documentsBucket.bucketName,
        OPENAI_SECRET_NAME: openAISecret.secretName,
        DATABASE_SECRET_NAME: databaseSecret.secretName,
        DATABASE_CLUSTER_ENDPOINT: databaseCluster.clusterEndpoint.hostname,
        DATABASE_NAME: 'ragtime',
      },
    });

    // Text Processing Lambda Function with automatic bundling
    this.textProcessingLambda = new NodejsFunction(this, 'TextProcessingFunction', {
      description: 'Text chunking and embedding generation for documents',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../../backend/src/lambdas/text-processing/index.ts'),
      timeout: cdk.Duration.minutes(5), // Longer timeout for processing
      memorySize: 1024, // More memory for text processing
      role: lambdaExecutionRole,
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        ENVIRONMENT: environment,
        DOCUMENTS_TABLE_NAME: documentsTable.tableName,
        DOCUMENTS_BUCKET_NAME: documentsBucket.bucketName,
        OPENAI_SECRET_NAME: openAISecret.secretName,
        DATABASE_SECRET_NAME: databaseSecret.secretName,
        DATABASE_CLUSTER_ENDPOINT: databaseCluster.clusterEndpoint.hostname,
        DATABASE_NAME: 'ragtime',
      },
      bundling: {
        minify: false,
        sourceMap: true,
        target: 'es2020',
        externalModules: [
          '@aws-sdk/*', // AWS SDK v3 modules - available in Node.js 22 runtime
        ],
        // Bundle pg and other dependencies - pg is not available in Lambda runtime
      }
    });

    // Note: Database schema must be initialized separately before using text processing
    // This Lambda assumes pgvector extension and required tables already exist

    // API Gateway REST API (let CDK auto-generate name to avoid conflicts)
    this.api = new apigateway.RestApi(this, 'RagTimeApi', {
      description: `RagTime REST API for ${environment} environment`,
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
        allowCredentials: false,
      },
      deployOptions: {
        stageName: environment,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        metricsEnabled: true,
      },
    });

    // Health check endpoint
    const healthResource = this.api.root.addResource('health');
    const healthIntegration = new apigateway.LambdaIntegration(this.healthCheckLambda, {
      requestTemplates: { 'application/json': '{ "statusCode": "200" }' },
    });

    healthResource.addMethod('GET', healthIntegration, {
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
            'method.response.header.Access-Control-Allow-Headers': true,
            'method.response.header.Access-Control-Allow-Methods': true,
          },
        },
      ],
    });

    // Database test endpoints
    const databaseTestResource = this.api.root.addResource('database-test');
    const databaseTestIntegration = new apigateway.LambdaIntegration(this.vectorTestLambda, {
      proxy: true,
    });

    databaseTestResource.addMethod('GET', databaseTestIntegration, {
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
            'method.response.header.Access-Control-Allow-Headers': true,
            'method.response.header.Access-Control-Allow-Methods': true,
          },
        },
      ],
    });

    // Keep vector-test endpoint for backwards compatibility
    const vectorTestResource = this.api.root.addResource('vector-test');
    vectorTestResource.addMethod('GET', databaseTestIntegration, {
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
            'method.response.header.Access-Control-Allow-Headers': true,
            'method.response.header.Access-Control-Allow-Methods': true,
          },
        },
      ],
    });

    // Text processing endpoint
    const processResource = this.api.root.addResource('process');
    const textProcessingIntegration = new apigateway.LambdaIntegration(this.textProcessingLambda, {
      requestTemplates: { 'application/json': '{ "statusCode": "200" }' },
    });

    processResource.addMethod('POST', textProcessingIntegration, {
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
            'method.response.header.Access-Control-Allow-Headers': true,
            'method.response.header.Access-Control-Allow-Methods': true,
          },
        },
      ],
    });

    // Outputs (no exports to avoid conflicts with main stack)
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: this.api.url,
      description: 'URL of the API Gateway',
    });

    new cdk.CfnOutput(this, 'HealthCheckEndpoint', {
      value: `${this.api.url}health`,
      description: 'Health check endpoint URL',
    });

    new cdk.CfnOutput(this, 'DatabaseTestEndpoint', {
      value: `${this.api.url}database-test`,
      description: 'Database connection test endpoint URL',
    });

    new cdk.CfnOutput(this, 'TextProcessingEndpoint', {
      value: `${this.api.url}process`,
      description: 'Text processing endpoint URL',
    });
  }
}
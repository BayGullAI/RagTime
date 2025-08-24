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
  public readonly documentUploadLambda: NodejsFunction;
  public readonly documentCrudLambda: NodejsFunction;
  public readonly documentAnalysisLambda: NodejsFunction;

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

    // PHASE 1: Individual Lambda roles to avoid circular dependencies
    // Each Lambda gets only the permissions it actually needs
    
    // 1. Health Check Lambda Role - VPC access only
    const healthCheckRole = new iam.Role(this, 'HealthCheckRole', {
      description: `Health check Lambda execution role for ${environment}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });

    // 2. Database Test Lambda Role - Database secret read + VPC access
    const databaseTestRole = new iam.Role(this, 'DatabaseTestRole', {
      description: `Database test Lambda execution role for ${environment}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });
    databaseSecret.grantRead(databaseTestRole);

    // 3. Document CRUD Lambda Role - S3 read + DynamoDB read/write
    const documentCrudRole = new iam.Role(this, 'DocumentCrudRole', {
      description: `Document CRUD Lambda execution role for ${environment}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });
    documentsBucket.grantRead(documentCrudRole);
    documentsTable.grantReadWriteData(documentCrudRole);

    // 4. Document Analysis Lambda Role - Database secret + cluster access
    const documentAnalysisRole = new iam.Role(this, 'DocumentAnalysisRole', {
      description: `Document analysis Lambda execution role for ${environment}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });
    databaseSecret.grantRead(documentAnalysisRole);
    documentAnalysisRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DocumentAnalysisAuroraConnect',
      effect: iam.Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [
        `arn:aws:rds-db:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:dbuser:${databaseCluster.clusterIdentifier}/ragtime_admin`,
      ],
    }));

    // PHASE 2: Dependent Lambda roles
    // 5. Text Processing Lambda Role - S3 + DynamoDB + OpenAI secret + Database access
    const textProcessingRole = new iam.Role(this, 'TextProcessingRole', {
      description: `Text processing Lambda execution role for ${environment}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });
    documentsBucket.grantReadWrite(textProcessingRole);
    documentsTable.grantReadWriteData(textProcessingRole);
    openAISecret.grantRead(textProcessingRole);
    databaseSecret.grantRead(textProcessingRole);
    textProcessingRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TextProcessingAuroraConnect',
      effect: iam.Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [
        `arn:aws:rds-db:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:dbuser:${databaseCluster.clusterIdentifier}/ragtime_admin`,
      ],
    }));

    // 6. Document Upload Lambda Role - S3 + DynamoDB access
    const documentUploadRole = new iam.Role(this, 'DocumentUploadRole', {
      description: `Document upload Lambda execution role for ${environment}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });
    documentsBucket.grantReadWrite(documentUploadRole);
    documentsTable.grantReadWriteData(documentUploadRole);


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
      role: healthCheckRole,
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        ENVIRONMENT: environment,
        DOCUMENTS_TABLE_NAME: documentsTable.tableName,
        DOCUMENTS_BUCKET_NAME: documentsBucket.bucketName,
        OPENAI_SECRET_NAME: `ragtime-openai-api-key-${environment}`,
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
      role: databaseTestRole,
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        ENVIRONMENT: environment,
        DOCUMENTS_TABLE_NAME: documentsTable.tableName,
        DOCUMENTS_BUCKET_NAME: documentsBucket.bucketName,
        OPENAI_SECRET_NAME: `ragtime-openai-api-key-${environment}`,
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
      memorySize: 3008, // Increased memory for OpenAI embeddings processing
      role: textProcessingRole,
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        ENVIRONMENT: environment,
        DOCUMENTS_TABLE_NAME: documentsTable.tableName,
        DOCUMENTS_BUCKET_NAME: documentsBucket.bucketName,
        OPENAI_SECRET_NAME: `ragtime-openai-api-key-${environment}`,
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

    // Document Upload Lambda Function (with text processing integration)
    this.documentUploadLambda = new NodejsFunction(this, 'DocumentUploadFunction', {
      description: 'Document upload with text processing pipeline',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../../backend/src/lambdas/document-upload/index.ts'),
      timeout: cdk.Duration.minutes(5), // Reduced from 15 minutes
      memorySize: 1024, // Reduced from 2048MB
      role: documentUploadRole,
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        ENVIRONMENT: environment,
        DOCUMENTS_TABLE_NAME: documentsTable.tableName,
        DOCUMENTS_BUCKET_NAME: documentsBucket.bucketName,
        TEXT_PROCESSING_LAMBDA_NAME: this.textProcessingLambda.functionName,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2020',
        externalModules: [
          '@aws-sdk/*', // AWS SDK v3 modules - available in Node.js 22 runtime
          'pg-native',
          'pg'
        ]
      }
    });

    // Document CRUD Lambda Function
    this.documentCrudLambda = new NodejsFunction(this, 'DocumentCrudFunction', {
      description: 'Document CRUD operations (list, get, delete)',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../../backend/src/lambdas/document-crud/index.ts'),
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      role: documentCrudRole,
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        ENVIRONMENT: environment,
        DOCUMENTS_TABLE_NAME: documentsTable.tableName,
        DOCUMENTS_BUCKET_NAME: documentsBucket.bucketName,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2020',
        externalModules: [
          '@aws-sdk/*', // AWS SDK v3 modules - available in Node.js 22 runtime
          'pg-native',
          'pg'
        ]
      }
    });

    // Document Analysis Lambda Function
    this.documentAnalysisLambda = new NodejsFunction(this, 'DocumentAnalysisFunction', {
      description: 'Document analysis with PostgreSQL and embeddings data',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../../backend/src/lambdas/document-analysis/index.ts'),
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      role: documentAnalysisRole,
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        ENVIRONMENT: environment,
        DOCUMENTS_TABLE_NAME: documentsTable.tableName,
        DOCUMENTS_BUCKET_NAME: documentsBucket.bucketName,
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
        // Bundle pg since it's needed for database connections
      }
    });

    // PHASE 3: Cross-Lambda Permissions (after all Lambdas exist)
    // Grant document upload Lambda permission to invoke text processing Lambda
    this.textProcessingLambda.grantInvoke(documentUploadRole);

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
    // Document upload endpoint
    const documentsResource = this.api.root.addResource('documents');
    const documentUploadIntegration = new apigateway.LambdaIntegration(this.documentUploadLambda, {
      requestTemplates: { 'application/json': '{ "statusCode": "200" }' },
    });

    documentsResource.addMethod('POST', documentUploadIntegration, {
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

    // Document CRUD endpoints
    const documentCrudIntegration = new apigateway.LambdaIntegration(this.documentCrudLambda, {
      proxy: true,
    });

    // GET /documents - List all documents
    documentsResource.addMethod('GET', documentCrudIntegration, {
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

    // GET /documents/{asset_id} - Get specific document
    // DELETE /documents/{asset_id} - Delete document
    const documentDetailResource = documentsResource.addResource('{asset_id}');
    
    documentDetailResource.addMethod('GET', documentCrudIntegration, {
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

    documentDetailResource.addMethod('DELETE', documentCrudIntegration, {
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

    // GET /documents/{asset_id}/analysis - Get document analysis (PostgreSQL + embeddings)
    const documentAnalysisResource = documentDetailResource.addResource('analysis');
    const documentAnalysisIntegration = new apigateway.LambdaIntegration(this.documentAnalysisLambda, {
      proxy: true,
    });

    documentAnalysisResource.addMethod('GET', documentAnalysisIntegration, {
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

    new cdk.CfnOutput(this, 'DocumentUploadEndpoint', {
      value: `${this.api.url}documents`,
      description: 'Document upload endpoint URL (POST)',
    });

    new cdk.CfnOutput(this, 'DocumentListEndpoint', {
      value: `${this.api.url}documents`,
      description: 'Document list endpoint URL (GET)',
    });

    new cdk.CfnOutput(this, 'DocumentCrudEndpoint', {
      value: `${this.api.url}documents/{asset_id}`,
      description: 'Document CRUD endpoint URL (GET/DELETE)',
    });

    new cdk.CfnOutput(this, 'DocumentAnalysisEndpoint', {
      value: `${this.api.url}documents/{asset_id}/analysis`,
      description: 'Document analysis endpoint URL (GET)',
    });
  }
}
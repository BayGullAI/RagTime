import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { RagTimeCDKToolkitStack } from './ragtime-toolkit-stack';

export interface RagTimeInfrastructureStackProps extends cdk.StackProps {
  environment: string;
  toolkitStack: RagTimeCDKToolkitStack;
}

export class RagTimeInfrastructureStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly documentsBucket: s3.Bucket;
  public readonly documentsTable: dynamodb.Table;
  public readonly api: apigateway.RestApi;
  public readonly healthCheckLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: RagTimeInfrastructureStackProps) {
    super(scope, id, props);

    const { environment, toolkitStack } = props;

    // VPC with public and private subnets across multiple AZs
    this.vpc = new ec2.Vpc(this, 'RagTimeVPC', {
      vpcName: `ragtime-vpc-${environment}`,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 3,
      natGateways: 2, // For high availability
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 28,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    // Security Groups
    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Lambda functions',
      allowAllOutbound: true,
    });

    const apiGatewaySecurityGroup = new ec2.SecurityGroup(this, 'ApiGatewaySecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for API Gateway VPC Link',
      allowAllOutbound: true,
    });

    // Allow HTTPS traffic
    apiGatewaySecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic'
    );

    // S3 Bucket for document storage
    this.documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      bucketName: `ragtime-documents-${environment}-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: toolkitStack.encryptionKey,
      versioned: true,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'DocumentLifecycle',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(30),
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
      removalPolicy: environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // DynamoDB Table for document metadata
    this.documentsTable = new dynamodb.Table(this, 'DocumentsTable', {
      tableName: `ragtime-documents-${environment}`,
      partitionKey: { name: 'tenant_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'asset_id', type: dynamodb.AttributeType.STRING },
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: toolkitStack.encryptionKey,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // GSI for time-based queries
    this.documentsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-TimeBasedQueries',
      partitionKey: { name: 'tenant_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1_sk', type: dynamodb.AttributeType.STRING }, // created_at#asset_id
    });

    // GSI for status-based queries
    this.documentsTable.addGlobalSecondaryIndex({
      indexName: 'GSI2-StatusBasedQueries',
      partitionKey: { name: 'gsi2_pk', type: dynamodb.AttributeType.STRING }, // tenant_id#status
      sortKey: { name: 'gsi2_sk', type: dynamodb.AttributeType.STRING }, // created_at#asset_id
    });

    // Lambda execution role
    const lambdaExecutionRole = new iam.Role(this, 'LambdaExecutionRole', {
      roleName: `RagTimeLambdaExecutionRole-${environment}`,
      description: `Lambda execution role for RagTime ${environment} environment`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });

    // Grant Lambda access to resources
    this.documentsBucket.grantReadWrite(lambdaExecutionRole);
    this.documentsTable.grantReadWriteData(lambdaExecutionRole);
    toolkitStack.encryptionKey.grantEncryptDecrypt(lambdaExecutionRole);

    // Health Check Lambda Function
    this.healthCheckLambda = new lambda.Function(this, 'HealthCheckFunction', {
      functionName: `ragtime-health-check-${environment}`,
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
      vpc: this.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        ENVIRONMENT: environment,
        DOCUMENTS_TABLE_NAME: this.documentsTable.tableName,
        DOCUMENTS_BUCKET_NAME: this.documentsBucket.bucketName,
      },
    });

    // API Gateway REST API
    this.api = new apigateway.RestApi(this, 'RagTimeApi', {
      restApiName: `ragtime-api-${environment}`,
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

    // VPC Endpoints for AWS services (for better security and performance)
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [
        {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    this.vpc.addGatewayEndpoint('DynamoDBEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      subnets: [
        {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'VPCId', {
      value: this.vpc.vpcId,
      description: 'ID of the VPC',
      exportName: `RagTimeVPCId-${environment}`,
    });

    new cdk.CfnOutput(this, 'DocumentsBucketName', {
      value: this.documentsBucket.bucketName,
      description: 'Name of the documents bucket',
      exportName: `RagTimeDocumentsBucket-${environment}`,
    });

    new cdk.CfnOutput(this, 'DocumentsTableName', {
      value: this.documentsTable.tableName,
      description: 'Name of the documents table',
      exportName: `RagTimeDocumentsTable-${environment}`,
    });

    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: this.api.url,
      description: 'URL of the API Gateway',
      exportName: `RagTimeApiUrl-${environment}`,
    });

    new cdk.CfnOutput(this, 'HealthCheckEndpoint', {
      value: `${this.api.url}health`,
      description: 'Health check endpoint URL',
      exportName: `RagTimeHealthCheckUrl-${environment}`,
    });
  }
}
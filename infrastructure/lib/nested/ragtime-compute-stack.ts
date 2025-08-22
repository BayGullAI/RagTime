import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface RagTimeComputeStackProps extends cdk.NestedStackProps {
  environment: string;
  vpc: ec2.Vpc;
  documentsBucket: s3.Bucket;
  documentsTable: dynamodb.Table;
  encryptionKey: kms.Key;
  openSearchDomain: opensearch.Domain;
  openAISecret: secretsmanager.Secret;
}

export class RagTimeComputeStack extends cdk.NestedStack {
  public readonly api: apigateway.RestApi;
  public readonly healthCheckLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: RagTimeComputeStackProps) {
    super(scope, id, props);

    const { environment, vpc, documentsBucket, documentsTable, encryptionKey, openSearchDomain, openAISecret } = props;

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
    encryptionKey.grantEncryptDecrypt(lambdaExecutionRole);
    openAISecret.grantRead(lambdaExecutionRole);

    // Grant Lambda access to OpenSearch domain
    lambdaExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'es:ESHttpGet',
        'es:ESHttpPost',
        'es:ESHttpPut',
        'es:ESHttpDelete',
        'es:ESHttpHead',
      ],
      resources: [openSearchDomain.domainArn, `${openSearchDomain.domainArn}/*`],
    }));

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
        OPENSEARCH_ENDPOINT: openSearchDomain.domainEndpoint,
        OPENAI_SECRET_NAME: openAISecret.secretName,
      },
    });

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

    // Outputs (no exports to avoid conflicts with main stack)
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: this.api.url,
      description: 'URL of the API Gateway',
    });

    new cdk.CfnOutput(this, 'HealthCheckEndpoint', {
      value: `${this.api.url}health`,
      description: 'Health check endpoint URL',
    });
  }
}
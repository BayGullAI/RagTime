import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { RagTimeCDKToolkitStack } from './ragtime-toolkit-stack';
import { RagTimeComputeStack } from './nested/ragtime-compute-stack';
import { RagTimeMonitoringStack } from './nested/ragtime-monitoring-stack';

export interface RagTimeInfrastructureStackProps extends cdk.StackProps {
  environment: string;
  toolkitStack: RagTimeCDKToolkitStack;
}

export class RagTimeInfrastructureStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly documentsBucket: s3.Bucket;
  public readonly documentsTable: dynamodb.Table;
  public readonly computeStack: RagTimeComputeStack;
  public readonly monitoringStack: RagTimeMonitoringStack;

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
              transitionAfter: cdk.Duration.days(120),
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

    // Nested Stack: Compute (Lambda + API Gateway)
    this.computeStack = new RagTimeComputeStack(this, 'ComputeStack', {
      environment,
      vpc: this.vpc,
      documentsBucket: this.documentsBucket,
      documentsTable: this.documentsTable,
      encryptionKey: toolkitStack.encryptionKey,
    });

    // Nested Stack: Monitoring (CloudWatch Canaries)
    this.monitoringStack = new RagTimeMonitoringStack(this, 'MonitoringStack', {
      environment,
      apiGatewayUrl: this.computeStack.api.url,
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
      value: this.computeStack.api.url,
      description: 'URL of the API Gateway',
      exportName: `RagTimeApiUrl-${environment}`,
    });

    new cdk.CfnOutput(this, 'HealthCheckEndpoint', {
      value: `${this.computeStack.api.url}health`,
      description: 'Health check endpoint URL',
      exportName: `RagTimeHealthCheckUrl-${environment}`,
    });
  }
}
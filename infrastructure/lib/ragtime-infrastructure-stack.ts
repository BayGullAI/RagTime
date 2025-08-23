import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { RagTimeCDKToolkitStack } from './ragtime-toolkit-stack';
import { RagTimeComputeStack } from './nested/ragtime-compute-stack';
import { RagTimeMonitoringStack } from './nested/ragtime-monitoring-stack';
import { RagTimeStorageStack } from './nested/ragtime-storage-stack';
import { RagTimeCoreStack } from './nested/ragtime-core-stack';

export interface RagTimeInfrastructureStackProps extends cdk.StackProps {
  environment: string;
  toolkitStack: RagTimeCDKToolkitStack;
}

export class RagTimeInfrastructureStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly documentsBucket: s3.Bucket;
  public readonly documentsTable: dynamodb.Table;
  public readonly storageStack: RagTimeStorageStack;
  public readonly computeStack: RagTimeComputeStack;
  public readonly monitoringStack: RagTimeMonitoringStack;
  public readonly coreStack: RagTimeCoreStack;

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

    // Nested Stack: Storage (S3 + DynamoDB)
    this.storageStack = new RagTimeStorageStack(this, 'StorageStack', {
      environment,
    });
    
    // Reference storage resources for backward compatibility
    this.documentsBucket = this.storageStack.documentsBucket;
    this.documentsTable = this.storageStack.documentsTable;

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

    // Nested Stack: Core Services (PostgreSQL Database and OpenAI Secrets Management)
    this.coreStack = new RagTimeCoreStack(this, 'CoreStack', {
      environment,
      vpc: this.vpc,
      documentsBucket: this.documentsBucket,
    });

    // Nested Stack: Compute (Lambda + API Gateway)
    this.computeStack = new RagTimeComputeStack(this, 'ComputeStack', {
      environment,
      vpc: this.vpc,
      documentsBucket: this.documentsBucket,
      documentsTable: this.documentsTable,
      openAISecret: this.coreStack.openAISecret,
      databaseCluster: this.coreStack.databaseCluster,
      databaseSecret: this.coreStack.databaseSecret,
    });

    // Nested Stack: Monitoring (CloudWatch Canaries)
    this.monitoringStack = new RagTimeMonitoringStack(this, 'MonitoringStack', {
      environment,
      apiGatewayUrl: this.computeStack.api.url,
    });

    // Outputs (no exports to avoid circular dependencies with toolkit stack)
    new cdk.CfnOutput(this, 'VPCId', {
      value: this.vpc.vpcId,
      description: 'ID of the VPC',
    });

    new cdk.CfnOutput(this, 'DocumentsBucketName', {
      value: this.documentsBucket.bucketName,
      description: 'Name of the documents bucket',
    });

    new cdk.CfnOutput(this, 'DocumentsTableName', {
      value: this.documentsTable.tableName,
      description: 'Name of the documents table',
    });

    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: this.computeStack.api.url,
      description: 'URL of the API Gateway',
    });

    new cdk.CfnOutput(this, 'HealthCheckEndpoint', {
      value: `${this.computeStack.api.url}health`,
      description: 'Health check endpoint URL',
    });


  }
}
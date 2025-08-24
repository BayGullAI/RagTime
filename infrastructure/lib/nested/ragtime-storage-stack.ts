import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface RagTimeStorageStackProps extends cdk.NestedStackProps {
  environment: string;
}

export class RagTimeStorageStack extends cdk.NestedStack {
  public readonly documentsBucket: s3.Bucket;
  public readonly documentsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: RagTimeStorageStackProps) {
    super(scope, id, props);

    const { environment } = props;

    // S3 Bucket for document storage
    this.documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      bucketName: `ragtime-documents-${environment}-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
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
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
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

    // Outputs (no exports to avoid circular dependencies)
    // Updated to force stack refresh - 2025-08-24
    new cdk.CfnOutput(this, 'DocumentsBucketName', {
      value: this.documentsBucket.bucketName,
      description: 'Name of the documents bucket',
    });

    new cdk.CfnOutput(this, 'DocumentsTableName', {
      value: this.documentsTable.tableName,
      description: 'Name of the documents table',
    });
  }
}
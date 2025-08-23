import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as triggers from 'aws-cdk-lib/triggers';
import { Construct } from 'constructs';
import * as path from 'path';

export interface RagTimeCoreStackProps extends cdk.NestedStackProps {
  environment: string;
  vpc: ec2.Vpc;
}

export class RagTimeCoreStack extends cdk.NestedStack {
  public readonly openAISecret: secretsmanager.Secret;
  public readonly databaseCluster: rds.DatabaseCluster;
  public readonly databaseSecret: secretsmanager.Secret;
  public readonly databaseInitialization: triggers.Trigger;

  constructor(scope: Construct, id: string, props: RagTimeCoreStackProps) {
    super(scope, id, props);

    const { environment, vpc } = props;

    // OpenAI API Key Secret
    // Check if OpenAI API key is provided via environment variable
    const openaiApiKey = process.env.OPENAI_API_KEY;
    
    if (openaiApiKey) {
      // If API key is provided, create secret with the actual key
      this.openAISecret = new secretsmanager.Secret(this, 'OpenAISecretWithKey', {
        secretName: `ragtime-openai-api-key-${environment}`,
        description: 'OpenAI API key for embedding generation',
        secretObjectValue: {
          api_key: cdk.SecretValue.unsafePlainText(openaiApiKey),
        },
        // Use default AWS managed encryption to avoid cross-stack dependencies
      });
    } else {
      // If no API key provided, create secret with placeholder for manual setup
      this.openAISecret = new secretsmanager.Secret(this, 'OpenAISecretPlaceholder', {
        secretName: `ragtime-openai-api-key-${environment}`,
        description: 'OpenAI API key for embedding generation (set manually)',
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ api_key: 'REPLACE_WITH_ACTUAL_OPENAI_API_KEY' }),
          generateStringKey: 'api_key',
          excludeCharacters: '"@/\\\'',
        },
        // Use default AWS managed encryption to avoid cross-stack dependencies
      });
    }

    // Aurora PostgreSQL Database Secret
    this.databaseSecret = new secretsmanager.Secret(this, 'DatabaseSecret', {
      secretName: `ragtime-database-credentials-${environment}`,
      description: 'Aurora PostgreSQL database credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'ragtime_admin' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\\'',
        passwordLength: 32,
      },
    });

    // Security group for Aurora PostgreSQL
    const databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      description: 'Security group for Aurora PostgreSQL cluster',
      allowAllOutbound: false,
    });

    // Allow PostgreSQL access from Lambda functions in VPC
    databaseSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      'Allow PostgreSQL access from VPC'
    );

    // Create DB subnet group for Aurora
    const dbSubnetGroup = new rds.SubnetGroup(this, 'DatabaseSubnetGroup', {
      description: 'Subnet group for Aurora PostgreSQL cluster',
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // Aurora PostgreSQL cluster with pgvector support
    this.databaseCluster = new rds.DatabaseCluster(this, 'VectorDatabase', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_3,
      }),
      credentials: rds.Credentials.fromSecret(this.databaseSecret),
      writer: rds.ClusterInstance.serverlessV2('writer', {
        autoMinorVersionUpgrade: true,
        scaleWithWriter: true,
      }),
      readers: [],
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [databaseSecurityGroup],
      defaultDatabaseName: 'ragtime',
      storageEncrypted: true,
      monitoringInterval: cdk.Duration.minutes(1),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 2.0,
      backup: {
        retention: environment === 'prod' ? cdk.Duration.days(30) : cdk.Duration.days(7),
        preferredWindow: '03:00-04:00',
      },
      preferredMaintenanceWindow: 'sun:04:00-sun:05:00',
      deletionProtection: environment === 'prod',
      removalPolicy: environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Create Lambda function to initialize database schema
    const migrationLambda = new NodejsFunction(this, 'DatabaseMigrationFunction', {
      description: 'Initialize database schema with pgvector extension and tables',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../lambda/database-migration/index.ts'),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      environment: {
        DATABASE_CLUSTER_ENDPOINT: this.databaseCluster.clusterEndpoint.hostname,
        DATABASE_SECRET_NAME: this.databaseSecret.secretName,
      },
      bundling: {
        minify: false,
        sourceMap: true,
        target: 'es2020',
        externalModules: [
          'aws-sdk', // AWS SDK v2 is provided by the Lambda runtime  
        ],
        nodeModules: [
          'pg',
          '@aws-sdk/client-secrets-manager'
        ],
        commandHooks: {
          beforeBundling: (inputDir: string, outputDir: string): string[] => {
            return [];
          },
          afterBundling: (inputDir: string, outputDir: string): string[] => {
            return [
              `cp ${inputDir}/infrastructure/lambda/database-migration/001_initial_pgvector_schema.sql ${outputDir}/001_initial_pgvector_schema.sql`
            ];
          },
          beforeInstall: (inputDir: string, outputDir: string): string[] => {
            return [];
          },
        },
      },
    });

    // Grant Lambda access to read database secret
    this.databaseSecret.grantRead(migrationLambda);

    // Create trigger to run migration Lambda after database is ready
    this.databaseInitialization = new triggers.Trigger(this, 'InitialSchemaMigration', {
      handler: migrationLambda,
      executeAfter: [this.databaseCluster],
    });

    // Outputs
    new cdk.CfnOutput(this, 'OpenAISecretName', {
      value: this.openAISecret.secretName,
      description: 'OpenAI API key secret name',
    });

    new cdk.CfnOutput(this, 'DatabaseClusterEndpoint', {
      value: this.databaseCluster.clusterEndpoint.hostname,
      description: 'Aurora PostgreSQL cluster endpoint',
    });

    new cdk.CfnOutput(this, 'DatabaseSecretName', {
      value: this.databaseSecret.secretName,
      description: 'Database credentials secret name',
    });

    new cdk.CfnOutput(this, 'DatabaseName', {
      value: 'ragtime',
      description: 'Database name',
    });
  }
}
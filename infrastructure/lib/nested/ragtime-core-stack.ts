import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as triggers from 'aws-cdk-lib/triggers';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as path from 'path';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';

export interface RagTimeCoreStackProps extends cdk.NestedStackProps {
  environment: string;
  vpc: ec2.Vpc;
  documentsBucket?: s3.IBucket; // Optional reference to documents bucket for pipeline testing
}

export class RagTimeCoreStack extends cdk.NestedStack {
  public readonly openAISecret: secretsmanager.Secret;
  public readonly databaseCluster: rds.DatabaseCluster;
  public readonly databaseSecret: secretsmanager.Secret;
  public readonly databaseInitialization: triggers.Trigger;
  public readonly databaseValidationFunctionName: string;
  public readonly pipelineTestingFunctionName?: string;

  constructor(scope: Construct, id: string, props: RagTimeCoreStackProps) {
    super(scope, id, props);

    const { environment, vpc, documentsBucket } = props;

    // OpenAI API Key Secret
    const openaiSecretName = `ragtime-openai-api-key-${environment}`;
    const importExistingSecret = this.node.tryGetContext('importExistingSecret');
    
    if (importExistingSecret) {
      // Import existing secret instead of creating new one
      this.openAISecret = secretsmanager.Secret.fromSecretNameV2(this, 'ImportedOpenAISecret', openaiSecretName) as secretsmanager.Secret;
    } else {
      // Check if OpenAI API key is provided via environment variable
      const openaiApiKey = process.env.OPENAI_API_KEY;
      
      if (openaiApiKey) {
        // If API key is provided, create secret with the actual key
        this.openAISecret = new secretsmanager.Secret(this, 'OpenAISecretWithKey', {
          secretName: openaiSecretName,
          description: 'OpenAI API key for embedding generation',
          secretObjectValue: {
            api_key: cdk.SecretValue.unsafePlainText(openaiApiKey),
          },
          // Use default AWS managed encryption to avoid cross-stack dependencies
        });
      } else {
        // If no API key provided, create secret with placeholder for manual setup
        this.openAISecret = new secretsmanager.Secret(this, 'OpenAISecretPlaceholder', {
          secretName: openaiSecretName,
          description: 'OpenAI API key for embedding generation (set manually)',
          generateSecretString: {
            secretStringTemplate: JSON.stringify({ api_key: 'REPLACE_WITH_ACTUAL_OPENAI_API_KEY' }),
            generateStringKey: 'api_key',
            excludeCharacters: '"@/\\\'',
          },
          // Use default AWS managed encryption to avoid cross-stack dependencies
        });
      }
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

    // Security group for Lambda functions
    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
      description: 'Security group for Lambda functions',
      allowAllOutbound: true, // Allow all outbound for internet access
    });

    // Allow PostgreSQL access from Lambda security group
    databaseSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(lambdaSecurityGroup.securityGroupId),
      ec2.Port.tcp(5432),
      'Allow PostgreSQL access from Lambda functions'
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
        version: rds.AuroraPostgresEngineVersion.VER_15_8,
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
      defaultDatabaseName: 'ragtime', // Explicitly create the database
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

    // Upload all SQL migration files to S3 as a directory asset
    const migrationsAsset = new s3assets.Asset(this, 'MigrationsAsset', {
      path: path.join(__dirname, '../../lambda/database-migration'),
      exclude: ['index.ts', 'package.json', '*.js', '*.map'], // Only include .sql files
    });

    // Create Lambda function to initialize database schema
    const migrationLambda = new NodejsFunction(this, 'DatabaseMigrationFunction', {
      description: 'Initialize database schema with pgvector extension and tables',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../lambda/database-migration/index.ts'),
      timeout: cdk.Duration.minutes(10),
      memorySize: 512,
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        DATABASE_CLUSTER_ENDPOINT: this.databaseCluster.clusterEndpoint.hostname,
        DATABASE_SECRET_NAME: this.databaseSecret.secretName,
        DATABASE_NAME: 'ragtime',
        MIGRATIONS_ASSET_BUCKET: migrationsAsset.bucket.bucketName,
        MIGRATIONS_ASSET_KEY: migrationsAsset.s3ObjectKey,
      },
      bundling: {
        minify: false,
        sourceMap: true,
        target: 'es2020',
        externalModules: [
          '@aws-sdk/*', // AWS SDK v3 modules - available in Node.js 22 runtime
          // Note: 'pg' module needs to be bundled as it's not available in Lambda runtime
        ],
      },
    });

    // Grant Lambda access to read database secret
    this.databaseSecret.grantRead(migrationLambda);
    
    // Grant Lambda access to read migrations asset from S3
    migrationsAsset.grantRead(migrationLambda);

    // Create trigger to run migration Lambda after database cluster and instances are ready
    this.databaseInitialization = new triggers.Trigger(this, 'InitialSchemaMigration', {
      handler: migrationLambda,
      executeAfter: [this.databaseCluster, this.databaseSecret],
    });

    // Create database validation canary to verify correlation tracking infrastructure
    const validationCanaryLambda = new NodejsFunction(this, 'DatabaseValidationCanaryFunction', {
      description: 'Validate correlation tracking schema and indexes are properly configured',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../lambda/database-validation-canary/index.ts'),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        DATABASE_CLUSTER_ENDPOINT: this.databaseCluster.clusterEndpoint.hostname,
        DATABASE_SECRET_NAME: this.databaseSecret.secretName,
        DATABASE_NAME: 'ragtime',
      },
      bundling: {
        minify: false,
        sourceMap: true,
        target: 'es2020',
        externalModules: [
          '@aws-sdk/*', // AWS SDK v3 modules - available in Node.js 22 runtime
        ],
      },
    });

    // Grant validation canary access to read database secret
    this.databaseSecret.grantRead(validationCanaryLambda);

    // TODO: Re-enable after deployment issues are resolved
    // Create EventBridge rule to run validation canary every 15 minutes
    // const validationCanaryRule = new events.Rule(this, 'DatabaseValidationCanarySchedule', {
    //   description: 'Run database validation canary every 15 minutes to verify correlation tracking',
    //   schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
    // });

    // Add the validation canary Lambda as target
    // validationCanaryRule.addTarget(new targets.LambdaFunction(validationCanaryLambda));

    // Also create a trigger to run validation canary once after migrations complete
    // const initialValidationTrigger = new triggers.Trigger(this, 'InitialValidationTrigger', {
    //   handler: validationCanaryLambda,
    //   executeAfter: [this.databaseInitialization], // Run after migrations complete
    // });

    // PHASE 2: Pipeline Testing Canary (Basic Implementation - Web extraction to be added later)
    
    // Create Pipeline Testing Canary (Phase 2 implementation - without web extraction for now)
    if (documentsBucket) {
      const pipelineTestingCanary = new NodejsFunction(this, 'PipelineTestingCanaryFunction', {
        description: 'Comprehensive end-to-end pipeline testing canary',
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'handler',
        entry: path.join(__dirname, '../../lambda/pipeline-testing-canary/index.ts'),
        timeout: cdk.Duration.minutes(10),
        memorySize: 1024,
        vpc: vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroups: [lambdaSecurityGroup],
        environment: {
          DATABASE_CLUSTER_ENDPOINT: this.databaseCluster.clusterEndpoint.hostname,
          DATABASE_SECRET_NAME: this.databaseSecret.secretName,
          DATABASE_NAME: 'ragtime',
          DOCUMENTS_BUCKET_NAME: documentsBucket.bucketName,
          OPENAI_SECRET_NAME: openaiSecretName,
        },
        bundling: {
          minify: false,
          sourceMap: true,
          target: 'es2020',
          externalModules: [
            '@aws-sdk/*',
          ],
        },
      });

      // Grant pipeline testing canary necessary permissions
      this.databaseSecret.grantRead(pipelineTestingCanary);
      this.openAISecret.grantRead(pipelineTestingCanary);
      documentsBucket.grantReadWrite(pipelineTestingCanary);

      // TODO: Enable after initial testing
      // Create EventBridge rule to run pipeline canary every 30 minutes
      // const pipelineCanaryRule = new events.Rule(this, 'PipelineTestingCanarySchedule', {
      //   description: 'Run comprehensive pipeline testing canary every 30 minutes',
      //   schedule: events.Schedule.rate(cdk.Duration.minutes(30)),
      // });
      // pipelineCanaryRule.addTarget(new targets.LambdaFunction(pipelineTestingCanary));

      // Set public property for pipeline testing function name
      this.pipelineTestingFunctionName = pipelineTestingCanary.functionName;

      // Output pipeline canary function name
      new cdk.CfnOutput(this, 'PipelineTestingCanaryFunctionName', {
        value: pipelineTestingCanary.functionName,
        description: 'Pipeline testing canary Lambda function name',
      });
    }

    // Outputs
    new cdk.CfnOutput(this, 'OpenAISecretName', {
      value: openaiSecretName,
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

    // Set public properties for function names
    this.databaseValidationFunctionName = validationCanaryLambda.functionName;

    new cdk.CfnOutput(this, 'DatabaseValidationCanaryFunctionName', {
      value: validationCanaryLambda.functionName,
      description: 'Database validation canary Lambda function name',
    });

    new cdk.CfnOutput(this, 'DatabaseName', {
      value: 'ragtime',
      description: 'Database name',
    });
  }
}
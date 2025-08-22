import * as cdk from 'aws-cdk-lib';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface RagTimeCoreStackProps extends cdk.NestedStackProps {
  environment: string;
  vpc: ec2.Vpc;
}

export class RagTimeCoreStack extends cdk.NestedStack {
  public readonly domain: opensearch.Domain;
  public readonly domainEndpoint: string;
  public readonly openAISecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: RagTimeCoreStackProps) {
    super(scope, id, props);

    const { environment, vpc } = props;

    // OpenAI API Key Secret
    this.openAISecret = new secretsmanager.Secret(this, 'OpenAISecret', {
      secretName: `ragtime-openai-api-key-${environment}`,
      description: 'OpenAI API key for embedding generation',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ api_key: '' }),
        generateStringKey: 'api_key',
        excludeCharacters: '"@/\\\'',
      },
      // Use default AWS managed encryption to avoid cross-stack dependencies
    });

    // Security group for OpenSearch domain
    const openSearchSecurityGroup = new ec2.SecurityGroup(this, 'OpenSearchSecurityGroup', {
      securityGroupName: `ragtime-opensearch-sg-${environment}`,
      vpc,
      description: 'Security group for OpenSearch domain',
      allowAllOutbound: false,
    });

    // Allow HTTPS traffic from Lambda functions in VPC (port 443 only - HTTP disabled)
    openSearchSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic from VPC for OpenSearch API access'
    );

    // Restricted egress - only HTTPS for AWS services and internal communication
    openSearchSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Allow HTTPS within VPC for cluster communication'
    );

    // Allow HTTPS to AWS services (for managed service communication)
    openSearchSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS to AWS services for managed OpenSearch operations'
    );

    // Create OpenSearch domain with vector search capabilities
    // Using smaller instance type to improve availability during AWS service issues
    this.domain = new opensearch.Domain(this, 'VectorSearchDomain', {
      domainName: `ragtime-vector-search-${environment}`,
      version: opensearch.EngineVersion.OPENSEARCH_2_7,
      
      // Using smaller instance types for better availability
      capacity: {
        dataNodes: 1, // Single node for dev to reduce resource constraints
        dataNodeInstanceType: 't3.small.search', // Smaller, more available instance type
        masterNodes: 0, // No dedicated masters to reduce resource usage
      },

      // Reduced storage configuration
      ebs: {
        volumeSize: 20, // Smaller volume size
        volumeType: ec2.EbsDeviceVolumeType.GP2, // Standard GP2 instead of GP3
      },

      // VPC configuration for security
      vpc,
      vpcSubnets: [
        {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
      securityGroups: [openSearchSecurityGroup],

      // Encryption configuration (using default AWS managed keys)
      encryptionAtRest: {
        enabled: true,
      },
      nodeToNodeEncryption: true,
      enforceHttps: true,

      // Minimal logging configuration to reduce resource usage
      logging: {
        slowSearchLogEnabled: false,
        appLogEnabled: false,
        slowIndexLogEnabled: false,
      },

      // Access will be controlled via IAM roles on Lambda functions
      // No resource-based access policies to follow principle of least privilege

      // Removal policy
      removalPolicy: environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Store domain endpoint for use by other stacks
    this.domainEndpoint = this.domain.domainEndpoint;

    // Outputs for reference
    new cdk.CfnOutput(this, 'OpenSearchDomainEndpoint', {
      value: this.domainEndpoint,
      description: 'OpenSearch domain endpoint URL',
    });

    new cdk.CfnOutput(this, 'OpenSearchDomainName', {
      value: this.domain.domainName,
      description: 'OpenSearch domain name',
    });

    new cdk.CfnOutput(this, 'OpenSearchDashboardsUrl', {
      value: `${this.domainEndpoint}/_dashboards/`,
      description: 'OpenSearch Dashboards URL',
    });

    new cdk.CfnOutput(this, 'OpenAISecretName', {
      value: this.openAISecret.secretName,
      description: 'OpenAI API key secret name',
    });
  }
}
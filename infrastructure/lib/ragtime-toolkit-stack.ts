import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export class RagTimeCDKToolkitStack extends cdk.Stack {
  public readonly assetsBucket: s3.Bucket;
  public readonly deploymentRole: iam.Role;
  public readonly encryptionKey: kms.Key;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // KMS Key for encryption
    this.encryptionKey = new kms.Key(this, 'RagTimeDeploymentKey', {
      description: 'RagTime CDK deployment encryption key',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.encryptionKey.addAlias('alias/ragtime-cdk-toolkit');

    // S3 Bucket for CDK assets
    this.assetsBucket = new s3.Bucket(this, 'RagTimeCDKAssets', {
      bucketName: `ragtime-cdk-assets-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      versioned: true,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'DeleteOldVersions',
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
        {
          id: 'DeleteIncompleteMultipartUploads',
          enabled: true,
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // CDK Deployment Role
    this.deploymentRole = new iam.Role(this, 'RagTimeCDKDeploymentRole', {
      roleName: 'RagTimeCDKDeploymentRole',
      description: 'Role used by CDK for RagTime deployments',
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('cloudformation.amazonaws.com'),
        new iam.ServicePrincipal('codebuild.amazonaws.com'),
        new iam.AccountPrincipal(cdk.Aws.ACCOUNT_ID),
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('PowerUserAccess'),
      ],
    });

    // Additional permissions for IAM (PowerUser doesn't include IAM)
    this.deploymentRole.addToPolicy(new iam.PolicyStatement({
      sid: 'IAMPermissions',
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:CreateRole',
        'iam:DeleteRole',
        'iam:UpdateRole',
        'iam:PutRolePolicy',
        'iam:DeleteRolePolicy',
        'iam:GetRole',
        'iam:GetRolePolicy',
        'iam:ListRolePolicies',
        'iam:AttachRolePolicy',
        'iam:DetachRolePolicy',
        'iam:CreatePolicy',
        'iam:DeletePolicy',
        'iam:GetPolicy',
        'iam:ListPolicyVersions',
        'iam:PassRole',
      ],
      resources: ['*'],
    }));

    // Bucket access for the deployment role
    this.assetsBucket.grantReadWrite(this.deploymentRole);
    this.encryptionKey.grantEncryptDecrypt(this.deploymentRole);

    // CloudFormation execution role
    const cfnExecutionRole = new iam.Role(this, 'RagTimeCFNExecutionRole', {
      roleName: 'RagTimeCFNExecutionRole',
      description: 'Role used by CloudFormation for RagTime stack operations',
      assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('PowerUserAccess'),
      ],
    });

    // Additional permissions for IAM
    cfnExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'IAMPermissions',
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:CreateRole',
        'iam:DeleteRole',
        'iam:UpdateRole',
        'iam:PutRolePolicy',
        'iam:DeleteRolePolicy',
        'iam:GetRole',
        'iam:GetRolePolicy',
        'iam:ListRolePolicies',
        'iam:AttachRolePolicy',
        'iam:DetachRolePolicy',
        'iam:CreatePolicy',
        'iam:DeletePolicy',
        'iam:GetPolicy',
        'iam:ListPolicyVersions',
        'iam:PassRole',
      ],
      resources: ['*'],
    }));

    // Outputs (no exports to avoid circular dependencies with infrastructure stack)
    new cdk.CfnOutput(this, 'AssetsBucketName', {
      value: this.assetsBucket.bucketName,
      description: 'Name of the CDK assets bucket',
    });

    new cdk.CfnOutput(this, 'DeploymentRoleArn', {
      value: this.deploymentRole.roleArn,
      description: 'ARN of the CDK deployment role',
    });

    new cdk.CfnOutput(this, 'EncryptionKeyArn', {
      value: this.encryptionKey.keyArn,
      description: 'ARN of the deployment encryption key',
    });
  }
}
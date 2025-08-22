import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { RagTimeCDKToolkitStack } from './ragtime-toolkit-stack';

export interface RagTimePipelineStackProps extends cdk.StackProps {
  environment: string;
  toolkitStack: RagTimeCDKToolkitStack;
}

export class RagTimePipelineStack extends cdk.Stack {
  public readonly codeBuildProject: codebuild.Project;
  public readonly codeBuildRole: iam.Role;

  constructor(scope: Construct, id: string, props: RagTimePipelineStackProps) {
    super(scope, id, props);

    const { environment, toolkitStack } = props;

    // CloudWatch Log Group for CodeBuild
    const logGroup = new logs.LogGroup(this, 'RagTimeBuildLogs', {
      logGroupName: `/aws/codebuild/ragtime-${environment}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CodeBuild Service Role
    this.codeBuildRole = new iam.Role(this, 'RagTimeCodeBuildRole', {
      roleName: `RagTimeCodeBuildRole-${environment}`,
      description: `CodeBuild service role for RagTime ${environment} environment`,
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('PowerUserAccess'),
      ],
    });

    // Additional permissions for IAM operations (needed for CDK deploy)
    this.codeBuildRole.addToPolicy(new iam.PolicyStatement({
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
        'iam:CreateServiceLinkedRole',
      ],
      resources: ['*'],
    }));

    // STS permissions for assuming deployment role
    this.codeBuildRole.addToPolicy(new iam.PolicyStatement({
      sid: 'STSPermissions',
      effect: iam.Effect.ALLOW,
      actions: [
        'sts:AssumeRole',
        'sts:GetCallerIdentity',
      ],
      resources: [
        toolkitStack.deploymentRole.roleArn,
        '*', // Allow assuming any role for cross-account deployments
      ],
    }));

    // CloudWatch Logs permissions
    this.codeBuildRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogsPermissions',
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [
        logGroup.logGroupArn,
        `${logGroup.logGroupArn}:*`,
      ],
    }));

    // Grant access to toolkit resources
    toolkitStack.assetsBucket.grantReadWrite(this.codeBuildRole);
    toolkitStack.encryptionKey.grantEncryptDecrypt(this.codeBuildRole);

    // CodeBuild Project
    this.codeBuildProject = new codebuild.Project(this, 'RagTimeCodeBuildProject', {
      projectName: `ragtime-${environment}`,
      description: `RagTime CI/CD pipeline for ${environment} environment`,
      source: codebuild.Source.gitHub({
        owner: 'BayGullAI',
        repo: 'RagTime',
        webhook: true,
        webhookFilters: [
          codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH).andBranchIs('main'),
          codebuild.FilterGroup.inEventOf(codebuild.EventAction.PULL_REQUEST_UPDATED),
        ],
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
        privileged: false,
        environmentVariables: {
          AWS_DEFAULT_REGION: {
            value: cdk.Aws.REGION,
          },
          AWS_ACCOUNT_ID: {
            value: cdk.Aws.ACCOUNT_ID,
          },
          DEPLOYMENT_ENVIRONMENT: {
            value: environment,
          },
          CDK_DEFAULT_ACCOUNT: {
            value: cdk.Aws.ACCOUNT_ID,
          },
          CDK_DEFAULT_REGION: {
            value: cdk.Aws.REGION,
          },
          RAGTIME_ASSETS_BUCKET: {
            value: toolkitStack.assetsBucket.bucketName,
          },
          RAGTIME_DEPLOYMENT_ROLE_ARN: {
            value: toolkitStack.deploymentRole.roleArn,
          },
        },
      },
      role: this.codeBuildRole,
      timeout: cdk.Duration.minutes(60),
      logging: {
        cloudWatch: {
          logGroup,
          enabled: true,
        },
      },
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.DOCKER_LAYER),
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
    });

    // Outputs
    new cdk.CfnOutput(this, 'CodeBuildProjectName', {
      value: this.codeBuildProject.projectName,
      description: 'Name of the CodeBuild project',
      exportName: `RagTimeCodeBuildProject-${environment}`,
    });

    new cdk.CfnOutput(this, 'CodeBuildProjectArn', {
      value: this.codeBuildProject.projectArn,
      description: 'ARN of the CodeBuild project',
      exportName: `RagTimeCodeBuildProjectArn-${environment}`,
    });

    new cdk.CfnOutput(this, 'CodeBuildRoleArn', {
      value: this.codeBuildRole.roleArn,
      description: 'ARN of the CodeBuild service role',
      exportName: `RagTimeCodeBuildRoleArn-${environment}`,
    });

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: logGroup.logGroupName,
      description: 'Name of the CloudWatch log group for builds',
      exportName: `RagTimeBuildLogGroup-${environment}`,
    });
  }
}
import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { RagTimeCDKToolkitStack } from './ragtime-toolkit-stack';

export interface RagTimePipelineStackProps extends cdk.StackProps {
  environment: string;
  toolkitStack: RagTimeCDKToolkitStack;
  githubToken?: string;
}

export class RagTimePipelineStack extends cdk.Stack {
  public readonly codeBuildProject: codebuild.Project;
  public readonly codeBuildRole: iam.Role;

  constructor(scope: Construct, id: string, props: RagTimePipelineStackProps) {
    super(scope, id, props);

    const { environment, toolkitStack, githubToken } = props;

    // CloudWatch Log Group for CodeBuild
    const logGroup = new logs.LogGroup(this, 'RagTimeBuildLogs', {
      logGroupName: '/aws/codebuild/ragtime-pipeline',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CodeBuild Service Role
    this.codeBuildRole = new iam.Role(this, 'RagTimeCodeBuildRole', {
      roleName: 'RagTimeCodeBuildRole',
      description: 'CodeBuild service role for RagTime pipeline',
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

    // SSM Parameter Store permissions for GitHub token
    this.codeBuildRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SSMParameterStorePermissions',
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
      ],
      resources: [
        `arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/ragtime/github-token`,
      ],
    }));

    // CodeBuild permissions to update own project environment variables
    this.codeBuildRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CodeBuildProjectUpdatePermissions',
      effect: iam.Effect.ALLOW,
      actions: [
        'codebuild:UpdateProject',
        'codebuild:BatchGetProjects',
      ],
      resources: [
        `arn:aws:codebuild:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:project/ragtime-pipeline`,
      ],
    }));

    // Grant access to toolkit resources
    toolkitStack.assetsBucket.grantReadWrite(this.codeBuildRole);
    toolkitStack.encryptionKey.grantEncryptDecrypt(this.codeBuildRole);

    // CodeBuild Project
    const sourceProps: any = {
      owner: 'BayGullAI',
      repo: 'RagTime',
      webhook: true,
      webhookFilters: [
        codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH).andBranchIs('main'),
        codebuild.FilterGroup.inEventOf(codebuild.EventAction.PULL_REQUEST_CREATED),
        codebuild.FilterGroup.inEventOf(codebuild.EventAction.PULL_REQUEST_UPDATED),
        codebuild.FilterGroup.inEventOf(codebuild.EventAction.PULL_REQUEST_REOPENED),
      ],
    };

    // Add GitHub token for status reporting
    if (githubToken) {
      sourceProps.accessToken = cdk.SecretValue.unsafePlainText(githubToken);
    } else {
      // Get GitHub token from SSM Parameter Store
      sourceProps.accessToken = cdk.SecretValue.ssmSecure('/ragtime/github-token');
    }

    this.codeBuildProject = new codebuild.Project(this, 'RagTimeCodeBuildProject', {
      projectName: 'ragtime-pipeline',
      description: 'RagTime CI/CD pipeline for all environments with PR support',
      source: codebuild.Source.gitHub(sourceProps),
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

    // Outputs (no exports to avoid circular dependencies with toolkit stack)
    new cdk.CfnOutput(this, 'CodeBuildProjectName', {
      value: this.codeBuildProject.projectName,
      description: 'Name of the CodeBuild project',
    });

    new cdk.CfnOutput(this, 'CodeBuildProjectArn', {
      value: this.codeBuildProject.projectArn,
      description: 'ARN of the CodeBuild project',
    });

    new cdk.CfnOutput(this, 'CodeBuildRoleArn', {
      value: this.codeBuildRole.roleArn,
      description: 'ARN of the CodeBuild service role',
    });

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: logGroup.logGroupName,
      description: 'Name of the CloudWatch log group for builds',
    });
  }
}
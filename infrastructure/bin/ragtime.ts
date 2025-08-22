#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RagTimeCDKToolkitStack } from '../lib/ragtime-toolkit-stack';
import { RagTimePipelineStack } from '../lib/ragtime-pipeline-stack';
import { RagTimeInfrastructureStack } from '../lib/ragtime-infrastructure-stack';

const app = new cdk.App();

// Get environment configuration
const account = process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID;
const region = process.env.CDK_DEFAULT_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const environment = process.env.DEPLOYMENT_ENVIRONMENT || 'dev';

// Environment configuration
const env = { account, region };

// Stack 1: Custom CDK Toolkit (Bootstrap)
const toolkitStack = new RagTimeCDKToolkitStack(app, 'RagTimeCDKToolkit', {
  env,
  description: 'RagTime CDK Toolkit - Custom bootstrap resources for CDK deployments',
});

// Stack 2: CI/CD Pipeline 
const githubToken = app.node.tryGetContext('githubToken') || process.env.GITHUB_TOKEN;
const pipelineStack = new RagTimePipelineStack(app, 'RagTimePipeline', {
  env,
  description: 'RagTime CI/CD Pipeline - CodeBuild pipeline for all environments',
  environment,
  toolkitStack,
  githubToken,
});

// Stack 3: Core Infrastructure
const infrastructureStack = new RagTimeInfrastructureStack(app, `RagTimeInfrastructure-${environment}`, {
  env,
  description: `RagTime Core Infrastructure - VPC, networking, and foundational services for ${environment} environment`,
  environment,
  toolkitStack,
});

// Add dependencies
pipelineStack.addDependency(toolkitStack);
infrastructureStack.addDependency(toolkitStack);

// Tags
cdk.Tags.of(app).add('Project', 'RagTime');
cdk.Tags.of(app).add('Environment', environment);
cdk.Tags.of(app).add('ManagedBy', 'CDK');
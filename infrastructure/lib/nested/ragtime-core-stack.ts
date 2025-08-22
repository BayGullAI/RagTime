import * as cdk from 'aws-cdk-lib';
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
  public readonly openAISecret: secretsmanager.Secret;

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


    new cdk.CfnOutput(this, 'OpenAISecretName', {
      value: this.openAISecret.secretName,
      description: 'OpenAI API key secret name',
    });
  }
}
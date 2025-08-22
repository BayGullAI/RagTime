#!/bin/bash

# Setup script for GitHub-CodeBuild integration
# This script sets up the necessary GitHub token and permissions

echo "Setting up GitHub integration for CodeBuild..."

# Step 1: Create GitHub Personal Access Token (you need to do this manually)
echo "MANUAL STEP REQUIRED:"
echo "1. Go to GitHub Settings > Developer settings > Personal access tokens"
echo "2. Create a new token with these permissions:"
echo "   - repo (Full control of private repositories)"
echo "   - admin:repo_hook (Full control of repository hooks)"
echo "   - admin:org_hook (Full control of organization hooks)"
echo "3. Copy the token and run the following command:"
echo ""
echo "aws secretsmanager create-secret \\"
echo "    --name 'github-token' \\"
echo "    --description 'GitHub token for CodeBuild status reporting' \\"
echo "    --secret-string '{\"token\":\"YOUR_GITHUB_TOKEN_HERE\"}'"
echo ""

# Step 2: Grant CodeBuild role access to the secret
echo "# Grant CodeBuild role access to GitHub token secret"
echo "aws secretsmanager put-resource-policy \\"
echo "    --secret-id 'github-token' \\"
echo "    --resource-policy '{"
echo "        \"Version\": \"2012-10-17\","
echo "        \"Statement\": ["
echo "            {"
echo "                \"Effect\": \"Allow\","
echo "                \"Principal\": {"
echo "                    \"AWS\": \"arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):role/RagTimeCodeBuildRole\""
echo "                },"
echo "                \"Action\": \"secretsmanager:GetSecretValue\","
echo "                \"Resource\": \"*\""
echo "            }"
echo "        ]"
echo "    }'"

# Step 3: Verify current webhook configuration
echo ""
echo "# Current webhook configuration:"
aws codebuild batch-get-projects --names ragtime-pipeline --query 'projects[0].webhook'

echo ""
echo "After creating the GitHub token, deploy the updated CDK stack:"
echo "cd infrastructure && npm run build && cdk deploy RagTime-Pipeline"
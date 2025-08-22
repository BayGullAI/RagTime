# Quick GitHub Integration Setup

## Problem
CodeBuild is not triggering for PRs and GitHub status checks are not showing up because:
1. Missing GitHub token for status reporting
2. Limited PR webhook events
3. Missing SSM Parameter Store permissions

## Solution Steps

### 1. Create GitHub Personal Access Token
1. Go to GitHub Settings > Developer settings > Personal access tokens > Tokens (classic)
2. Click "Generate new token"
3. Select these scopes:
   - `repo` (Full control of private repositories)
   - `admin:repo_hook` (Full control of repository hooks)
4. Copy the generated token

### 2. Store Token in AWS SSM Parameter Store
```bash
# Replace YOUR_GITHUB_TOKEN_HERE with your actual token
aws ssm put-parameter \
    --name "/ragtime/github-token" \
    --value "YOUR_GITHUB_TOKEN_HERE" \
    --type "SecureString" \
    --description "GitHub token for CodeBuild status reporting"
```

### 3. Deploy Updated CDK Stack
```bash
cd infrastructure
npm run build
cdk deploy RagTime-Pipeline --require-approval never
```

### 4. Verify Configuration
```bash
# Check if the parameter was created
aws ssm get-parameter --name "/ragtime/github-token" --with-decryption --query 'Parameter.Value' --output text

# Check updated webhook configuration
aws codebuild batch-get-projects --names ragtime-pipeline --query 'projects[0].webhook.filterGroups'
```

### 5. Test the Integration
1. Create a test commit on PR #9 or create a new PR
2. Check if CodeBuild build is triggered
3. Verify GitHub status checks appear in the PR

## Expected Results
- CodeBuild builds will trigger for PR created/updated/reopened events
- GitHub status checks will show up in PRs
- Build status will be reported back to GitHub automatically

## Troubleshooting
If builds still don't trigger:
1. Check CloudWatch logs for the webhook: `/aws/codebuild/ragtime-pipeline`
2. Verify GitHub webhook is receiving events: GitHub repo > Settings > Webhooks
3. Check IAM permissions for the CodeBuild role
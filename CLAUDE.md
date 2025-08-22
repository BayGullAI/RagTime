
# Configuration
- AWS credentials are setup at ~/.aws/credentials

# Git
- Make small logical changes, make sure it works, commit and push
- Make sure the commit message is concise but add specifics in the description
- IMPORTANT: When asked to "deploy the changes", DO NOT merge PRs. Only deploy the current branch
- Only merge PRs when explicitly asked to merge
- Before pushing to PR, build+test+eslint
- After pushing the commit, check the PR for status. If failed, fetch the failures and fix it


# Code Layout
- infrastructure: contains CDK 
- backend: nodejs based backend code
- tests: should contain 100% code coverage for backend and 80% for others


# API Gateway CORS Configuration
- IMPORTANT: ALL new API Gateway routes MUST have CORS enabled
- When adding new API Gateway resources, always include:
  ```typescript
  // On the resource
  defaultCorsPreflightOptions: {
    allowOrigins: apigateway.Cors.ALL_ORIGINS,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key', 'X-Amz-Security-Token'],
    allowCredentials: false,
  }
  ```
- When adding methods, include methodResponses with CORS headers:
  ```typescript
  // On each method
  methodResponses: [{
    statusCode: '200',
    responseParameters: {
      'method.response.header.Access-Control-Allow-Origin': true,
      'method.response.header.Access-Control-Allow-Headers': true,
      'method.response.header.Access-Control-Allow-Methods': true,
    },
  }]
  ```
- Lambda functions must return CORS headers using the shared createResponse function
- Test CORS functionality in browser before considering complete
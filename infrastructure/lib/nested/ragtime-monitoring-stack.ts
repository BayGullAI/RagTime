import * as cdk from 'aws-cdk-lib';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface RagTimeMonitoringStackProps extends cdk.NestedStackProps {
  environment: string;
  apiGatewayUrl: string;
}

export class RagTimeMonitoringStack extends cdk.NestedStack {
  public readonly healthCheckCanary: synthetics.Canary;
  public readonly corsTestCanary: synthetics.Canary;

  constructor(scope: Construct, id: string, props: RagTimeMonitoringStackProps) {
    super(scope, id, props);

    const { environment, apiGatewayUrl } = props;

    // S3 bucket for storing canary artifacts
    const canaryArtifactsBucket = new s3.Bucket(this, 'CanaryArtifactsBucket', {
      bucketName: `ragtime-canary-artifacts-${environment}-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'CanaryArtifactsLifecycle',
          enabled: true,
          expiration: cdk.Duration.days(30), // Clean up artifacts after 30 days
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // IAM role for canaries
    const canaryExecutionRole = new iam.Role(this, 'CanaryExecutionRole', {
      roleName: `RagTimeCanaryExecutionRole-${environment}`,
      description: `Execution role for CloudWatch Canaries in ${environment} environment`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant canary role access to S3 bucket for artifacts
    canaryArtifactsBucket.grantReadWrite(canaryExecutionRole);

    // Grant CloudWatch permissions
    canaryExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudwatch:PutMetricData',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: ['*'],
    }));

    // Health Check Canary using HTTP request
    this.healthCheckCanary = new synthetics.Canary(this, 'HealthCheckCanary', {
      canaryName: `ragtime-health-${environment}`,
      schedule: synthetics.Schedule.rate(cdk.Duration.minutes(15)),
      test: synthetics.Test.custom({
        code: synthetics.Code.fromInline(`
const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');
const https = require('https');
const { URL } = require('url');

const healthCheckBlueprint = async function () {
    const healthUrl = '${apiGatewayUrl}health';
    log.info('Starting health check for: ' + healthUrl);
    
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        
        try {
            const parsedUrl = new URL(healthUrl);
            
            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || 443,
                path: parsedUrl.pathname,
                method: 'GET',
                headers: {
                    'User-Agent': 'AWS-Synthetics-Canary'
                }
            };
            
            const req = https.request(options, (res) => {
                let responseBody = '';
                
                res.on('data', (chunk) => {
                    responseBody += chunk;
                });
                
                res.on('end', () => {
                    const responseTime = Date.now() - startTime;
                    
                    try {
                        // Check status code
                        if (res.statusCode !== 200) {
                            reject(new Error(\`Health check failed with status: \${res.statusCode}\`));
                            return;
                        }
                        
                        // Parse JSON response
                        let healthData;
                        try {
                            healthData = JSON.parse(responseBody);
                        } catch (parseError) {
                            reject(new Error(\`Health check response is not valid JSON: \${parseError.message}\`));
                            return;
                        }
                        
                        // Validate required fields
                        if (healthData.status !== 'healthy') {
                            reject(new Error(\`Health check status is not healthy: \${healthData.status}\`));
                            return;
                        }
                        
                        if (!healthData.timestamp) {
                            reject(new Error('Health check response missing timestamp'));
                            return;
                        }
                        
                        if (!healthData.services) {
                            reject(new Error('Health check response missing services status'));
                            return;
                        }
                        
                        // Verify response time
                        if (responseTime > 5000) {
                            reject(new Error(\`Health check response time too slow: \${responseTime}ms\`));
                            return;
                        }
                        
                        log.info(\`Health check passed - Status: \${healthData.status}, Response time: \${responseTime}ms\`);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            
            req.on('error', (error) => {
                reject(new Error(\`Health check request failed: \${error.message}\`));
            });
            
            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('Health check request timed out'));
            });
            
            req.end();
        } catch (error) {
            reject(new Error(\`Health check failed: \${error.message}\`));
        }
    });
};

exports.handler = async () => {
    return await synthetics.executeStep('healthCheck', healthCheckBlueprint);
};
        `),
        handler: 'index.handler',
      }),
      runtime: new synthetics.Runtime('syn-nodejs-puppeteer-10.0', synthetics.RuntimeFamily.NODEJS),
      environmentVariables: {
        API_URL: apiGatewayUrl,
      },
      role: canaryExecutionRole,
      artifactsBucketLocation: {
        bucket: canaryArtifactsBucket,
        prefix: 'health-check-canary',
      },
    });

    // CORS Test Canary using HTTP requests
    this.corsTestCanary = new synthetics.Canary(this, 'CorsTestCanary', {
      canaryName: `ragtime-cors-${environment}`,
      schedule: synthetics.Schedule.rate(cdk.Duration.minutes(15)),
      test: synthetics.Test.custom({
        code: synthetics.Code.fromInline(`
const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');
const https = require('https');
const { URL } = require('url');

const corsTestBlueprint = async function () {
    const healthUrl = '${apiGatewayUrl}health';
    log.info('Starting CORS test for: ' + healthUrl);
    
    const parsedUrl = new URL(healthUrl);
    
    // Test 1: Preflight OPTIONS request
    log.info('Testing CORS preflight request...');
    
    await new Promise((resolve, reject) => {
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.pathname,
            method: 'OPTIONS',
            headers: {
                'Origin': 'https://example.com',
                'Access-Control-Request-Method': 'GET',
                'Access-Control-Request-Headers': 'Content-Type',
                'User-Agent': 'AWS-Synthetics-Canary'
            }
        };
        
        const req = https.request(options, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(\`CORS preflight failed with status: \${res.statusCode}\`));
                return;
            }
            
            // Check required CORS headers
            const responseHeaders = {};
            Object.keys(res.headers).forEach(key => {
                responseHeaders[key.toLowerCase()] = res.headers[key];
            });
            
            const requiredCorsHeaders = [
                'access-control-allow-origin',
                'access-control-allow-methods',
                'access-control-allow-headers'
            ];
            
            for (const header of requiredCorsHeaders) {
                if (!responseHeaders[header]) {
                    reject(new Error(\`Missing CORS header in preflight response: \${header}\`));
                    return;
                }
            }
            
            log.info('CORS preflight test passed');
            resolve();
        });
        
        req.on('error', (error) => {
            reject(new Error(\`CORS preflight request failed: \${error.message}\`));
        });
        
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('CORS preflight request timed out'));
        });
        
        req.end();
    });
    
    // Test 2: Actual CORS request
    log.info('Testing actual CORS request...');
    
    await new Promise((resolve, reject) => {
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.pathname,
            method: 'GET',
            headers: {
                'Origin': 'https://example.com',
                'Content-Type': 'application/json',
                'User-Agent': 'AWS-Synthetics-Canary'
            }
        };
        
        const req = https.request(options, (res) => {
            let responseBody = '';
            
            res.on('data', (chunk) => {
                responseBody += chunk;
            });
            
            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        reject(new Error(\`CORS request failed with status: \${res.statusCode}\`));
                        return;
                    }
                    
                    // Check CORS headers in actual response
                    const responseHeaders = {};
                    Object.keys(res.headers).forEach(key => {
                        responseHeaders[key.toLowerCase()] = res.headers[key];
                    });
                    
                    if (!responseHeaders['access-control-allow-origin']) {
                        reject(new Error('Response missing Access-Control-Allow-Origin header'));
                        return;
                    }
                    
                    // Verify response body
                    let responseData;
                    try {
                        responseData = JSON.parse(responseBody);
                    } catch (parseError) {
                        reject(new Error(\`CORS response body is not valid JSON: \${parseError.message}\`));
                        return;
                    }
                    
                    if (responseData.status !== 'healthy') {
                        reject(new Error(\`CORS request returned unhealthy status: \${responseData.status}\`));
                        return;
                    }
                    
                    log.info('CORS functionality test passed');
                    
                    // Test 3: Verify allowed methods
                    const allowedMethods = responseHeaders['access-control-allow-methods'] || '';
                    const expectedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
                    
                    expectedMethods.forEach(method => {
                        if (!allowedMethods.toUpperCase().includes(method)) {
                            log.warn(\`Method \${method} not found in allowed methods: \${allowedMethods}\`);
                        }
                    });
                    
                    log.info('All CORS tests completed successfully');
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
        
        req.on('error', (error) => {
            reject(new Error(\`CORS request failed: \${error.message}\`));
        });
        
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('CORS request timed out'));
        });
        
        req.end();
    });
};

exports.handler = async () => {
    return await synthetics.executeStep('corsTest', corsTestBlueprint);
};
        `),
        handler: 'index.handler',
      }),
      runtime: new synthetics.Runtime('syn-nodejs-puppeteer-10.0', synthetics.RuntimeFamily.NODEJS),
      environmentVariables: {
        API_URL: apiGatewayUrl,
      },
      role: canaryExecutionRole,
      artifactsBucketLocation: {
        bucket: canaryArtifactsBucket,
        prefix: 'cors-test-canary',
      },
    });

    // CloudWatch Log Groups for canaries (with retention)
    new logs.LogGroup(this, 'HealthCheckCanaryLogGroup', {
      logGroupName: `/aws/lambda/cwsyn-${this.healthCheckCanary.canaryName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new logs.LogGroup(this, 'CorsTestCanaryLogGroup', {
      logGroupName: `/aws/lambda/cwsyn-${this.corsTestCanary.canaryName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Outputs
    new cdk.CfnOutput(this, 'CanaryArtifactsBucketName', {
      value: canaryArtifactsBucket.bucketName,
      description: 'S3 bucket for canary artifacts',
      exportName: `RagTimeCanaryArtifactsBucket-${environment}`,
    });

    new cdk.CfnOutput(this, 'HealthCheckCanaryName', {
      value: this.healthCheckCanary.canaryName,
      description: 'Name of the health check canary',
      exportName: `RagTimeHealthCheckCanary-${environment}`,
    });

    new cdk.CfnOutput(this, 'CorsTestCanaryName', {
      value: this.corsTestCanary.canaryName,
      description: 'Name of the CORS test canary',
      exportName: `RagTimeCorsTestCanary-${environment}`,
    });
  }
}
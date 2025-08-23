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
  public readonly databaseTestCanary: synthetics.Canary;
  public readonly documentUploadCanary: synthetics.Canary;
  public readonly documentCrudCanary: synthetics.Canary;

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
            if (res.statusCode !== 200 && res.statusCode !== 204) {
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

    // Database Connection Test Canary
    this.databaseTestCanary = new synthetics.Canary(this, 'DatabaseTestCanary', {
      canaryName: `ragtime-database-${environment}`,
      schedule: synthetics.Schedule.rate(cdk.Duration.minutes(15)),
      test: synthetics.Test.custom({
        code: synthetics.Code.fromInline(`
const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');
const https = require('https');
const { URL } = require('url');

const databaseTestBlueprint = async function () {
    const databaseTestUrl = '${apiGatewayUrl}database-test';
    log.info('Starting database connection test for: ' + databaseTestUrl);
    
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        
        try {
            const parsedUrl = new URL(databaseTestUrl);
            
            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || 443,
                path: parsedUrl.pathname,
                method: 'GET',
                headers: {
                    'User-Agent': 'AWS-Synthetics-Canary',
                    'Content-Type': 'application/json'
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
                            reject(new Error(\`Database test failed with status: \${res.statusCode} - \${responseBody}\`));
                            return;
                        }
                        
                        // Parse JSON response
                        let databaseData;
                        try {
                            databaseData = JSON.parse(responseBody);
                        } catch (parseError) {
                            reject(new Error(\`Database test response is not valid JSON: \${parseError.message}\`));
                            return;
                        }
                        
                        // Validate database connection response
                        if (!databaseData.message) {
                            reject(new Error('Database test response missing message'));
                            return;
                        }
                        
                        if (!databaseData.endpoint) {
                            reject(new Error('Database test response missing endpoint'));
                            return;
                        }
                        
                        if (!databaseData.database) {
                            reject(new Error('Database test response missing database name'));
                            return;
                        }
                        
                        if (!databaseData.username) {
                            reject(new Error('Database test response missing username'));
                            return;
                        }
                        
                        if (databaseData.status !== 'ready') {
                            reject(new Error(\`Database status is not ready: \${databaseData.status}\`));
                            return;
                        }
                        
                        if (!databaseData.timestamp) {
                            reject(new Error('Database test response missing timestamp'));
                            return;
                        }
                        
                        // Verify response time (database connections can be slower)
                        if (responseTime > 15000) {
                            reject(new Error(\`Database test response time too slow: \${responseTime}ms\`));
                            return;
                        }
                        
                        // Validate database endpoint format
                        if (!databaseData.endpoint.includes('cluster-') || !databaseData.endpoint.includes('rds.amazonaws.com')) {
                            reject(new Error(\`Invalid database endpoint format: \${databaseData.endpoint}\`));
                            return;
                        }
                        
                        // Validate database name
                        if (databaseData.database !== 'ragtime') {
                            reject(new Error(\`Unexpected database name: \${databaseData.database}\`));
                            return;
                        }
                        
                        // Validate username format
                        if (!databaseData.username || databaseData.username.length < 3) {
                            reject(new Error(\`Invalid database username: \${databaseData.username}\`));
                            return;
                        }
                        
                        log.info(\`Database connection test passed - Database: \${databaseData.database}, User: \${databaseData.username}, Response time: \${responseTime}ms\`);
                        log.info(\`Database endpoint: \${databaseData.endpoint}\`);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            
            req.on('error', (error) => {
                reject(new Error(\`Database test request failed: \${error.message}\`));
            });
            
            req.setTimeout(20000, () => {
                req.destroy();
                reject(new Error('Database test request timed out'));
            });
            
            req.end();
        } catch (error) {
            reject(new Error(\`Database test failed: \${error.message}\`));
        }
    });
};

exports.handler = async () => {
    return await synthetics.executeStep('databaseTest', databaseTestBlueprint);
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
        prefix: 'database-test-canary',
      },
    });

    // Document Upload Canary
    this.documentUploadCanary = new synthetics.Canary(this, 'DocumentUploadCanary', {
      canaryName: `ragtime-upload-${environment}`,
      schedule: synthetics.Schedule.rate(cdk.Duration.minutes(30)),
      test: synthetics.Test.custom({
        code: synthetics.Code.fromInline(`
const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');
const https = require('https');
const { URL } = require('url');

const documentUploadBlueprint = async function () {
    const uploadUrl = '${apiGatewayUrl}documents';
    const testTenantId = 'canary-test-' + Date.now();
    const testFileName = 'canary-test-document.txt';
    const testContent = 'This is a test document created by the CloudWatch Canary for monitoring document upload functionality. Created at: ' + new Date().toISOString();
    
    log.info('Starting document upload test for: ' + uploadUrl);
    
    // Create multipart form data
    const boundary = 'canary-boundary-' + Date.now();
    const formData = [
        \`--\${boundary}\`,
        'Content-Disposition: form-data; name="tenant_id"',
        '',
        testTenantId,
        \`--\${boundary}\`,
        \`Content-Disposition: form-data; name="file"; filename="\${testFileName}"\`,
        'Content-Type: text/plain',
        '',
        testContent,
        \`--\${boundary}--\`,
    ].join('\\r\\n');
    
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        
        try {
            const parsedUrl = new URL(uploadUrl);
            
            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || 443,
                path: parsedUrl.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': \`multipart/form-data; boundary=\${boundary}\`,
                    'Content-Length': Buffer.byteLength(formData),
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
                            reject(new Error(\`Document upload failed with status: \${res.statusCode} - \${responseBody}\`));
                            return;
                        }
                        
                        // Parse JSON response
                        let uploadData;
                        try {
                            uploadData = JSON.parse(responseBody);
                        } catch (parseError) {
                            reject(new Error(\`Upload response is not valid JSON: \${parseError.message}\`));
                            return;
                        }
                        
                        // Validate upload response
                        if (!uploadData.success) {
                            reject(new Error(\`Upload not successful: \${uploadData.message || 'Unknown error'}\`));
                            return;
                        }
                        
                        if (!uploadData.document || !uploadData.document.asset_id) {
                            reject(new Error('Upload response missing document or asset_id'));
                            return;
                        }
                        
                        if (!uploadData.document.tenant_id || uploadData.document.tenant_id !== testTenantId) {
                            reject(new Error(\`Upload response tenant_id mismatch: expected \${testTenantId}, got \${uploadData.document.tenant_id}\`));
                            return;
                        }
                        
                        if (uploadData.document.status !== 'PROCESSED') {
                            reject(new Error(\`Upload document status is not PROCESSED: \${uploadData.document.status}\`));
                            return;
                        }
                        
                        // Verify response time (uploads can be slower)
                        if (responseTime > 30000) {
                            reject(new Error(\`Upload response time too slow: \${responseTime}ms\`));
                            return;
                        }
                        
                        log.info(\`Document upload test passed - Asset ID: \${uploadData.document.asset_id}, Response time: \${responseTime}ms\`);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            
            req.on('error', (error) => {
                reject(new Error(\`Document upload request failed: \${error.message}\`));
            });
            
            req.setTimeout(45000, () => {
                req.destroy();
                reject(new Error('Document upload request timed out'));
            });
            
            req.write(formData);
            req.end();
        } catch (error) {
            reject(new Error(\`Document upload test failed: \${error.message}\`));
        }
    });
};

exports.handler = async () => {
    return await synthetics.executeStep('documentUpload', documentUploadBlueprint);
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
        prefix: 'document-upload-canary',
      },
    });

    // Document CRUD Canary (Read and Delete operations)
    this.documentCrudCanary = new synthetics.Canary(this, 'DocumentCrudCanary', {
      canaryName: `ragtime-crud-${environment}`,
      schedule: synthetics.Schedule.rate(cdk.Duration.minutes(15)),
      test: synthetics.Test.custom({
        code: synthetics.Code.fromInline(`
const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');
const https = require('https');
const { URL } = require('url');

const documentCrudBlueprint = async function () {
    const baseUrl = '${apiGatewayUrl}documents';
    const testTenantId = 'canary-crud-' + Date.now();
    
    log.info('Starting document CRUD test for: ' + baseUrl);
    
    // Test 1: List documents (Read operation)
    log.info('Testing document list endpoint...');
    
    await new Promise((resolve, reject) => {
        const listUrl = \`\${baseUrl}?tenant_id=\${testTenantId}&limit=10\`;
        const parsedUrl = new URL(listUrl);
        
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
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
                        reject(new Error(\`Document list failed with status: \${res.statusCode} - \${responseBody}\`));
                        return;
                    }
                    
                    let listData;
                    try {
                        listData = JSON.parse(responseBody);
                    } catch (parseError) {
                        reject(new Error(\`List response is not valid JSON: \${parseError.message}\`));
                        return;
                    }
                    
                    if (!Array.isArray(listData.documents)) {
                        reject(new Error('List response missing documents array'));
                        return;
                    }
                    
                    if (typeof listData.total_count !== 'number') {
                        reject(new Error('List response missing total_count'));
                        return;
                    }
                    
                    log.info(\`Document list test passed - Found \${listData.documents.length} documents\`);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
        
        req.on('error', (error) => {
            reject(new Error(\`Document list request failed: \${error.message}\`));
        });
        
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Document list request timed out'));
        });
        
        req.end();
    });
    
    // Test 2: Get specific document (Read operation) - using known pattern
    log.info('Testing document get endpoint...');
    
    await new Promise((resolve, reject) => {
        const testAssetId = 'test-canary-asset-' + Date.now();
        const getUrl = \`\${baseUrl}/\${testAssetId}?tenant_id=\${testTenantId}\`;
        const parsedUrl = new URL(getUrl);
        
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
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
                    // For non-existent document, we expect 404 - this is valid behavior
                    if (res.statusCode === 404) {
                        let errorData;
                        try {
                            errorData = JSON.parse(responseBody);
                        } catch (parseError) {
                            reject(new Error(\`404 response is not valid JSON: \${parseError.message}\`));
                            return;
                        }
                        
                        if (errorData.error === 'Document not found') {
                            log.info('Document get test passed - 404 response for non-existent document is correct');
                            resolve();
                            return;
                        }
                    }
                    
                    // If we get 200, validate the response structure
                    if (res.statusCode === 200) {
                        let getData;
                        try {
                            getData = JSON.parse(responseBody);
                        } catch (parseError) {
                            reject(new Error(\`Get response is not valid JSON: \${parseError.message}\`));
                            return;
                        }
                        
                        if (!getData.document) {
                            reject(new Error('Get response missing document'));
                            return;
                        }
                        
                        log.info('Document get test passed - Found existing document');
                        resolve();
                        return;
                    }
                    
                    reject(new Error(\`Document get returned unexpected status: \${res.statusCode} - \${responseBody}\`));
                } catch (error) {
                    reject(error);
                }
            });
        });
        
        req.on('error', (error) => {
            reject(new Error(\`Document get request failed: \${error.message}\`));
        });
        
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Document get request timed out'));
        });
        
        req.end();
    });
    
    // Test 3: Delete endpoint structure test (Delete operation)
    log.info('Testing document delete endpoint structure...');
    
    await new Promise((resolve, reject) => {
        const testAssetId = 'test-canary-delete-' + Date.now();
        const deleteUrl = \`\${baseUrl}/\${testAssetId}?tenant_id=\${testTenantId}\`;
        const parsedUrl = new URL(deleteUrl);
        
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'DELETE',
            headers: {
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
                    // For non-existent document, we expect 404 - this is valid behavior
                    if (res.statusCode === 404) {
                        let errorData;
                        try {
                            errorData = JSON.parse(responseBody);
                        } catch (parseError) {
                            reject(new Error(\`Delete 404 response is not valid JSON: \${parseError.message}\`));
                            return;
                        }
                        
                        if (errorData.error === 'Document not found') {
                            log.info('Document delete test passed - 404 response for non-existent document is correct');
                            resolve();
                            return;
                        }
                    }
                    
                    // If we get 200, validate the response structure
                    if (res.statusCode === 200) {
                        let deleteData;
                        try {
                            deleteData = JSON.parse(responseBody);
                        } catch (parseError) {
                            reject(new Error(\`Delete response is not valid JSON: \${parseError.message}\`));
                            return;
                        }
                        
                        if (!deleteData.success) {
                            reject(new Error('Delete response missing success field'));
                            return;
                        }
                        
                        log.info('Document delete test passed - Delete operation completed successfully');
                        resolve();
                        return;
                    }
                    
                    reject(new Error(\`Document delete returned unexpected status: \${res.statusCode} - \${responseBody}\`));
                } catch (error) {
                    reject(error);
                }
            });
        });
        
        req.on('error', (error) => {
            reject(new Error(\`Document delete request failed: \${error.message}\`));
        });
        
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Document delete request timed out'));
        });
        
        req.end();
    });
    
    log.info('All document CRUD tests completed successfully');
};

exports.handler = async () => {
    return await synthetics.executeStep('documentCrud', documentCrudBlueprint);
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
        prefix: 'document-crud-canary',
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

    new logs.LogGroup(this, 'DatabaseTestCanaryLogGroup', {
      logGroupName: `/aws/lambda/cwsyn-${this.databaseTestCanary.canaryName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new logs.LogGroup(this, 'DocumentUploadCanaryLogGroup', {
      logGroupName: `/aws/lambda/cwsyn-${this.documentUploadCanary.canaryName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new logs.LogGroup(this, 'DocumentCrudCanaryLogGroup', {
      logGroupName: `/aws/lambda/cwsyn-${this.documentCrudCanary.canaryName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Outputs (no exports to avoid circular dependencies with toolkit stack)
    new cdk.CfnOutput(this, 'CanaryArtifactsBucketName', {
      value: canaryArtifactsBucket.bucketName,
      description: 'S3 bucket for canary artifacts',
    });

    new cdk.CfnOutput(this, 'HealthCheckCanaryName', {
      value: this.healthCheckCanary.canaryName,
      description: 'Name of the health check canary',
    });

    new cdk.CfnOutput(this, 'CorsTestCanaryName', {
      value: this.corsTestCanary.canaryName,
      description: 'Name of the CORS test canary',
    });

    new cdk.CfnOutput(this, 'DatabaseTestCanaryName', {
      value: this.databaseTestCanary.canaryName,
      description: 'Name of the database connection test canary',
    });

    new cdk.CfnOutput(this, 'DocumentUploadCanaryName', {
      value: this.documentUploadCanary.canaryName,
      description: 'Name of the document upload test canary',
    });

    new cdk.CfnOutput(this, 'DocumentCrudCanaryName', {
      value: this.documentCrudCanary.canaryName,
      description: 'Name of the document CRUD test canary',
    });
  }
}
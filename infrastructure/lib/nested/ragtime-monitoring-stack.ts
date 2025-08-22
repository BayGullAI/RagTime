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
import json
import urllib.request
import urllib.error
import time

def handler(event, context):
    health_url = "${apiGatewayUrl}health"
    print(f"Starting health check for: {health_url}")
    
    try:
        start_time = time.time()
        
        # Create request with timeout
        request = urllib.request.Request(health_url)
        request.add_header('User-Agent', 'AWS-Synthetics-Canary')
        
        # Make HTTP GET request
        with urllib.request.urlopen(request, timeout=30) as response:
            response_time = (time.time() - start_time) * 1000
            
            # Check status code
            if response.status != 200:
                raise Exception(f"Health check failed with status: {response.status}")
            
            # Read response body
            response_body = response.read().decode('utf-8')
            
            # Parse JSON response
            try:
                health_data = json.loads(response_body)
            except json.JSONDecodeError as e:
                raise Exception(f"Health check response is not valid JSON: {str(e)}")
            
            # Validate required fields
            if health_data.get('status') != 'healthy':
                raise Exception(f"Health check status is not healthy: {health_data.get('status')}")
            
            if not health_data.get('timestamp'):
                raise Exception('Health check response missing timestamp')
            
            if not health_data.get('services'):
                raise Exception('Health check response missing services status')
            
            # Verify response time
            if response_time > 5000:
                raise Exception(f"Health check response time too slow: {response_time:.0f}ms")
            
            print(f"Health check passed - Status: {health_data['status']}, Response time: {response_time:.0f}ms")
            return {"statusCode": 200, "body": "Health check successful"}
            
    except urllib.error.URLError as e:
        print(f"URL Error: {str(e)}")
        raise Exception(f"Health check failed: {str(e)}")
    except Exception as e:
        print(f"Health check failed: {str(e)}")
        raise Exception(str(e))
        `),
        handler: 'index.handler',
      }),
      runtime: synthetics.Runtime.SYNTHETICS_PYTHON_SELENIUM_1_3,
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
import json
import urllib.request
import urllib.error

def handler(event, context):
    health_url = "${apiGatewayUrl}health"
    print(f"Starting CORS test for: {health_url}")
    
    try:
        # Test 1: Preflight OPTIONS request
        print("Testing CORS preflight request...")
        
        preflight_request = urllib.request.Request(health_url, method='OPTIONS')
        preflight_request.add_header('Origin', 'https://example.com')
        preflight_request.add_header('Access-Control-Request-Method', 'GET')
        preflight_request.add_header('Access-Control-Request-Headers', 'Content-Type')
        preflight_request.add_header('User-Agent', 'AWS-Synthetics-Canary')
        
        with urllib.request.urlopen(preflight_request, timeout=30) as response:
            if response.status != 200:
                raise Exception(f"CORS preflight failed with status: {response.status}")
            
            # Check required CORS headers
            response_headers = {k.lower(): v for k, v in response.headers.items()}
            required_cors_headers = [
                'access-control-allow-origin',
                'access-control-allow-methods',
                'access-control-allow-headers'
            ]
            
            for header in required_cors_headers:
                if header not in response_headers:
                    raise Exception(f"Missing CORS header in preflight response: {header}")
            
            print("CORS preflight test passed")
        
        # Test 2: Actual CORS request
        print("Testing actual CORS request...")
        
        cors_request = urllib.request.Request(health_url)
        cors_request.add_header('Origin', 'https://example.com')
        cors_request.add_header('Content-Type', 'application/json')
        cors_request.add_header('User-Agent', 'AWS-Synthetics-Canary')
        
        with urllib.request.urlopen(cors_request, timeout=30) as response:
            if response.status != 200:
                raise Exception(f"CORS request failed with status: {response.status}")
            
            # Check CORS headers in actual response
            response_headers = {k.lower(): v for k, v in response.headers.items()}
            
            if 'access-control-allow-origin' not in response_headers:
                raise Exception('Response missing Access-Control-Allow-Origin header')
            
            # Verify response body
            response_body = response.read().decode('utf-8')
            try:
                response_data = json.loads(response_body)
            except json.JSONDecodeError as e:
                raise Exception(f"CORS response body is not valid JSON: {str(e)}")
            
            if response_data.get('status') != 'healthy':
                raise Exception(f"CORS request returned unhealthy status: {response_data.get('status')}")
            
            print("CORS functionality test passed")
            
            # Test 3: Verify allowed methods
            allowed_methods = response_headers.get('access-control-allow-methods', '')
            expected_methods = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
            
            for method in expected_methods:
                if method not in allowed_methods.upper():
                    print(f"Warning: Method {method} not found in allowed methods: {allowed_methods}")
            
            print("All CORS tests completed successfully")
            return {"statusCode": 200, "body": "CORS tests successful"}
            
    except urllib.error.URLError as e:
        print(f"URL Error: {str(e)}")
        raise Exception(f"CORS test failed: {str(e)}")
    except Exception as e:
        print(f"CORS test failed: {str(e)}")
        raise Exception(str(e))
        `),
        handler: 'index.handler',
      }),
      runtime: synthetics.Runtime.SYNTHETICS_PYTHON_SELENIUM_1_3,
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
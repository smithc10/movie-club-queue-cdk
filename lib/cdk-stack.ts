import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

export interface MovieClubStackProps extends cdk.StackProps {
  hostedZone?: route53.IHostedZone;
  certificate?: acm.ICertificate;
  apiDomainName?: string; // e.g., "api.movieclubqueue.com"
}

export class MovieClubStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: MovieClubStackProps) {
    super(scope, id, props);

    // ===== STEP 1: DynamoDB Table =====
    const moviesTable = new dynamodb.Table(this, "MoviesTable", {
      tableName: "club-schedule",
      partitionKey: {
        name: "tmdb_id",
        type: dynamodb.AttributeType.NUMBER,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Keep data if stack is deleted
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      }, // Enable backups
    });

    // Add GSI for querying by discussion_date
    moviesTable.addGlobalSecondaryIndex({
      indexName: "discussion-date-index",
      partitionKey: {
        name: "status",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "discussion_date",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ===== STEP 2: Secrets Manager for TMDb API Key =====
    const tmdbSecret = new secretsmanager.Secret(this, "TMDbAPIKey", {
      secretName: "movie-club/tmdb-api-key",
      description: "TMDb API Key for movie data enrichment",
      // Note: Value must be manually added via AWS Console or CLI after deployment
    });

    // ===== STEP 3: Lambda Execution Role =====
    const lambdaRole = new iam.Role(this, "MovieClubLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole",
        ),
      ],
    });

    // Grant DynamoDB permissions
    moviesTable.grantReadWriteData(lambdaRole);

    // Grant Secrets Manager read permission (least privilege)
    tmdbSecret.grantRead(lambdaRole);

    // Common Lambda environment variables
    const commonEnv = {
      TABLE_NAME: moviesTable.tableName,
      TMDB_SECRET_ARN: tmdbSecret.secretArn,
      DISCUSSION_DATE_INDEX: "discussion-date-index",
    };

    // ===== STEP 4: Lambda Functions =====

    // Lambda: Get Schedule (GET /movies)
    const getScheduleFunction = new NodejsFunction(
      this,
      "GetScheduleFunction",
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: "handler",
        entry: "./api/get-schedule/index.ts",
        role: lambdaRole,
        environment: commonEnv,
        timeout: cdk.Duration.seconds(30), // Longer timeout for TMDb enrichment
        memorySize: 512,
        tracing: lambda.Tracing.ACTIVE, // Enable X-Ray tracing for debugging
      },
    );

    // Lambda: Add Movie (POST /movies)
    const addMovieFunction = new NodejsFunction(this, "AddMovieFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "handler",
      entry: "./api/add-movie/index.ts",
      role: lambdaRole,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(10),
      tracing: lambda.Tracing.ACTIVE, // Enable X-Ray tracing for debugging
    });

    // ===== STEP 5: API Gateway =====
    const api = new apigateway.RestApi(this, "MovieClubAPI", {
      restApiName: "Movie Club Schedule API",
      description:
        "API for managing and viewing the weekly movie club discussion queue",
      deployOptions: {
        stageName: "v1",
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
        tracingEnabled: true, // Enable X-Ray tracing for API Gateway
        // CloudWatch logging disabled - requires account-level IAM role setup
        // To enable: set up CloudWatch role via AWS Console first
        // loggingLevel: apigateway.MethodLoggingLevel.INFO,
        // dataTraceEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ["Content-Type", "X-Api-Key", "Authorization"],
      },
    });

    // API Key for write operations (temporary - will be replaced with Cognito)
    const apiKey = api.addApiKey("MovieClubAPIKey", {
      apiKeyName: "movie-club-admin-key",
      description: "API Key for admin write operations (temporary)",
    });

    // Usage Plan
    const usagePlan = api.addUsagePlan("MovieClubUsagePlan", {
      name: "StandardUsage",
      throttle: {
        rateLimit: 50,
        burstLimit: 100,
      },
      quota: {
        limit: 10000,
        period: apigateway.Period.MONTH,
      },
    });

    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: api.deploymentStage });

    // ===== Custom Domain for API Gateway (Optional) =====
    if (props?.hostedZone && props?.certificate && props?.apiDomainName) {
      const customDomain = new apigateway.DomainName(this, "ApiCustomDomain", {
        domainName: props.apiDomainName,
        certificate: props.certificate,
        securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
        endpointType: apigateway.EndpointType.REGIONAL,
      });

      // Map the custom domain to the API stage
      customDomain.addBasePathMapping(api, {
        basePath: "", // No base path, API available at api.movieclubqueue.com/
        stage: api.deploymentStage,
      });

      // Create Route 53 A record for API subdomain
      new route53.ARecord(this, "ApiARecord", {
        zone: props.hostedZone,
        recordName: props.apiDomainName,
        target: route53.RecordTarget.fromAlias(
          new targets.ApiGatewayDomain(customDomain),
        ),
        comment: "Alias to API Gateway custom domain",
      });

      new cdk.CfnOutput(this, "APICustomDomain", {
        value: `https://${props.apiDomainName}`,
        description: "API Gateway custom domain URL",
        exportName: "MovieClubAPICustomDomain",
      });
    }

    // ===== API Endpoints =====

    // /movies endpoint
    const movies = api.root.addResource("movies");

    // GET /movies (Public - retrieve full schedule)
    movies.addMethod(
      "GET",
      new apigateway.LambdaIntegration(getScheduleFunction),
      {
        methodResponses: [
          {
            statusCode: "200",
            responseModels: {
              "application/json": apigateway.Model.EMPTY_MODEL,
            },
          },
          {
            statusCode: "500",
          },
        ],
      },
    );

    // POST /movies (Secured with API key - add movie to queue)
    movies.addMethod(
      "POST",
      new apigateway.LambdaIntegration(addMovieFunction),
      {
        apiKeyRequired: true,
        methodResponses: [
          {
            statusCode: "201",
            responseModels: {
              "application/json": apigateway.Model.EMPTY_MODEL,
            },
          },
          {
            statusCode: "400",
          },
          {
            statusCode: "500",
          },
        ],
      },
    );

    // ===== Outputs =====
    new cdk.CfnOutput(this, "APIEndpoint", {
      value: api.url,
      description: "API Gateway endpoint URL",
      exportName: "MovieClubAPIEndpoint",
    });

    new cdk.CfnOutput(this, "APIId", {
      value: api.restApiId,
      description: "API Gateway ID for OpenAPI spec",
      exportName: "MovieClubAPIId",
    });

    new cdk.CfnOutput(this, "APIKeyId", {
      value: apiKey.keyId,
      description: "API Key ID (retrieve value from AWS Console)",
      exportName: "MovieClubAPIKeyId",
    });

    new cdk.CfnOutput(this, "DynamoDBTableName", {
      value: moviesTable.tableName,
      description: "DynamoDB table name",
      exportName: "MovieClubTableName",
    });

    new cdk.CfnOutput(this, "TMDbSecretArn", {
      value: tmdbSecret.secretArn,
      description: "Secrets Manager ARN for TMDb API Key",
      exportName: "TMDbSecretArn",
    });

    new cdk.CfnOutput(this, "Region", {
      value: this.region,
      description: "AWS Region",
      exportName: "MovieClubRegion",
    });
  }
}

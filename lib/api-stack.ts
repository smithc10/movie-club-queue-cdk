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
import * as cognito from "aws-cdk-lib/aws-cognito";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

export interface MovieClubApiStackProps extends cdk.StackProps {
  hostedZone: route53.IHostedZone;
  certificate: acm.ICertificate;
  apiDomainName: string; // e.g., "api.movieclubqueue.com"
  domainName: string; // e.g., "movieclubqueue.com" (for Cognito callback URLs)
}

export class MovieClubApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MovieClubApiStackProps) {
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

    // ===== STEP 3: Cognito User Pool =====
    const userPool = new cognito.UserPool(this, "MovieClubUserPool", {
      userPoolName: "movie-club-users",
      selfSignUpEnabled: false, // Admin creates users
      signInAliases: {
        email: true,
        username: false,
      },
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Keep users if stack deleted
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: false,
        otp: true,
      },
    });

    // User Pool Client for frontend SPA
    const userPoolClient = userPool.addClient("MovieClubWebClient", {
      userPoolClientName: "movie-club-web-app",
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: false,
        },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [
          `https://${props.domainName}/callback`,
          `https://www.${props.domainName}/callback`,
          "http://localhost:5173/callback",
        ],
        logoutUrls: [
          `https://${props.domainName}`,
          `https://www.${props.domainName}`,
          "http://localhost:5173",
        ],
      },
      preventUserExistenceErrors: true,
      generateSecret: false, // No secret for SPA (public client)
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // Cognito Domain for Hosted UI
    const cognitoDomain = userPool.addDomain("MovieClubCognitoDomain", {
      cognitoDomain: {
        domainPrefix: "movie-club-queue",
      },
    });

    // Admin Group for users who can manage the movie queue
    new cognito.CfnUserPoolGroup(this, "AdminGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "admin",
      description: "Club administrators who can manage the movie queue",
      precedence: 0,
    });

    // Cognito Authorizer for API Gateway
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "MovieClubAuthorizer",
      {
        cognitoUserPools: [userPool],
        authorizerName: "movie-club-cognito-authorizer",
        identitySource: "method.request.header.Authorization",
      },
    );

    // ===== STEP 4: Lambda Execution Role =====
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

    // ===== Custom Domain for API Gateway =====
    // Using EDGE endpoint type because the ACM certificate is in us-east-1 (required for CloudFront).
    // EDGE-optimized APIs use CloudFront, which requires certificates in us-east-1.
    // For REGIONAL endpoints, the certificate must be in the same region as the API.
    // See: https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-edge-optimized-custom-domain-name.html
    const customDomain = new apigateway.DomainName(this, "ApiCustomDomain", {
      domainName: props.apiDomainName,
      certificate: props.certificate,
      securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
      endpointType: apigateway.EndpointType.EDGE,
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

    // POST /movies (Secured with Cognito - add movie to queue)
    movies.addMethod(
      "POST",
      new apigateway.LambdaIntegration(addMovieFunction),
      {
        authorizer: cognitoAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
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
            statusCode: "401",
          },
          {
            statusCode: "403",
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

    // ===== Cognito Outputs =====
    new cdk.CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
      description: "Cognito User Pool ID",
      exportName: "MovieClubUserPoolId",
    });

    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
      description: "Cognito User Pool Client ID",
      exportName: "MovieClubUserPoolClientId",
    });

    new cdk.CfnOutput(this, "CognitoDomain", {
      value: cognitoDomain.domainName,
      description: "Cognito domain prefix",
      exportName: "MovieClubCognitoDomain",
    });

    new cdk.CfnOutput(this, "CognitoHostedUIUrl", {
      value: `https://${cognitoDomain.domainName}.auth.${this.region}.amazoncognito.com`,
      description: "Cognito Hosted UI URL",
      exportName: "MovieClubHostedUIUrl",
    });
  }
}

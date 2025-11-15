import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { MovieClubStack } from "../lib/cdk-stack";

describe("MovieClubStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new MovieClubStack(app, "TestMovieClubStack", {
      env: {
        account: "123456789012",
        region: "us-west-2",
      },
    });
    template = Template.fromStack(stack);
  });

  describe("DynamoDB Table", () => {
    test("should create table with correct partition key", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "club-schedule",
        KeySchema: [
          {
            AttributeName: "tmdb_id",
            KeyType: "HASH",
          },
        ],
        AttributeDefinitions: [
          {
            AttributeName: "tmdb_id",
            AttributeType: "N",
          },
          {
            AttributeName: "status",
            AttributeType: "S",
          },
          {
            AttributeName: "discussion_date",
            AttributeType: "S",
          },
        ],
      });
    });

    test("should use pay-per-request billing", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        BillingMode: "PAY_PER_REQUEST",
      });
    });

    test("should have point-in-time recovery enabled", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      });
    });

    test("should have Global Secondary Index for discussion dates", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        GlobalSecondaryIndexes: [
          {
            IndexName: "discussion-date-index",
            KeySchema: [
              {
                AttributeName: "status",
                KeyType: "HASH",
              },
              {
                AttributeName: "discussion_date",
                KeyType: "RANGE",
              },
            ],
            Projection: {
              ProjectionType: "ALL",
            },
          },
        ],
      });
    });

    test("should have exactly one DynamoDB table", () => {
      template.resourceCountIs("AWS::DynamoDB::Table", 1);
    });
  });

  describe("Secrets Manager", () => {
    test("should create TMDb API key secret", () => {
      template.hasResourceProperties("AWS::SecretsManager::Secret", {
        Description: "TMDb API Key for movie data enrichment",
        Name: "movie-club/tmdb-api-key",
      });
    });

    test("should have exactly one secret", () => {
      template.resourceCountIs("AWS::SecretsManager::Secret", 1);
    });
  });

  describe("IAM Role", () => {
    test("should create Lambda execution role", () => {
      template.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: "sts:AssumeRole",
              Effect: "Allow",
              Principal: {
                Service: "lambda.amazonaws.com",
              },
            },
          ],
        },
        ManagedPolicyArns: [
          {
            "Fn::Join": [
              "",
              [
                "arn:",
                { Ref: "AWS::Partition" },
                ":iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
              ],
            ],
          },
        ],
      });
    });

    test("should grant DynamoDB and Secrets Manager permissions to Lambda role", () => {
      // The policy has both DynamoDB and Secrets Manager statements
      const policies = template.findResources("AWS::IAM::Policy");
      const policyStatements =
        Object.values(policies)[0].Properties.PolicyDocument.Statement;

      // Check for DynamoDB permissions
      const dynamoStatement = policyStatements.find((s: any) =>
        s.Action.some((a: string) => a.startsWith("dynamodb:"))
      );
      expect(dynamoStatement).toBeDefined();
      expect(dynamoStatement.Effect).toBe("Allow");
      expect(dynamoStatement.Action).toContain("dynamodb:PutItem");
      expect(dynamoStatement.Action).toContain("dynamodb:GetItem");
      expect(dynamoStatement.Action).toContain("dynamodb:Query");

      // Check for Secrets Manager permissions
      const secretsStatement = policyStatements.find((s: any) =>
        s.Action.some((a: string) => a.startsWith("secretsmanager:"))
      );
      expect(secretsStatement).toBeDefined();
      expect(secretsStatement.Effect).toBe("Allow");
      expect(secretsStatement.Action).toContain(
        "secretsmanager:GetSecretValue"
      );
      expect(secretsStatement.Action).toContain(
        "secretsmanager:DescribeSecret"
      );
    });
  });

  describe("Stack Outputs", () => {
    test("should export DynamoDB table name", () => {
      template.hasOutput("DynamoDBTableName", {
        Description: "DynamoDB table name",
        Export: {
          Name: "MovieClubTableName",
        },
      });
    });

    test("should export TMDb secret ARN", () => {
      template.hasOutput("TMDbSecretArn", {
        Description: "Secrets Manager ARN for TMDb API Key",
        Export: {
          Name: "TMDbSecretArn",
        },
      });
    });

    test("should export region", () => {
      template.hasOutput("Region", {
        Description: "AWS Region",
        Export: {
          Name: "MovieClubRegion",
        },
      });
    });
  });

  describe("Resource Counts", () => {
    test("should not create Lambda functions (commented out)", () => {
      template.resourceCountIs("AWS::Lambda::Function", 0);
    });

    test("should not create API Gateway (commented out)", () => {
      template.resourceCountIs("AWS::ApiGateway::RestApi", 0);
    });
  });
});

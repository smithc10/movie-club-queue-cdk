#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { MovieClubApiStack } from "../lib/api-stack";
import { MovieClubWebsiteStack } from "../lib/website-stack";

const app = new cdk.App();

// Domain name from context (can override with: cdk deploy -c domainName=example.com)
const domainName = app.node.tryGetContext("domainName") ?? "movieclubqueue.com";
const apiDomainName = `api.${domainName}`;

// Frontend Stack - must be in us-east-1 for ACM certificate (CloudFront requirement)
// See: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html
const websiteStack = new MovieClubWebsiteStack(
  app,
  "MovieClubQueueWebsiteStack",
  {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: "us-east-1", // CloudFront + ACM require us-east-1
    },
    domainName: domainName,
    description: "Movie Club frontend hosting with CloudFront, S3, and WAF",
    crossRegionReferences: true, // Allow cross-region stack references
  },
);

// Backend API Stack - deployed in us-west-2
const apiStack = new MovieClubApiStack(app, "MovieClubQueueApiStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-west-2",
  },
  description: "Movie Club movie schedule management infrastructure",
  hostedZone: websiteStack.hostedZone,
  certificate: websiteStack.certificate,
  apiDomainName: apiDomainName,
  domainName: domainName, // For Cognito callback URLs
  crossRegionReferences: true, // Allow cross-region stack references
});

// Ensure website stack deploys first
apiStack.addDependency(websiteStack);

app.synth();

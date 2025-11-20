#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { MovieClubStack } from "../lib/cdk-stack";
import { FrontendStack } from "../lib/frontend-stack";

const app = new cdk.App();

const domainName = "movieclubqueue.com";
const apiDomainName = `api.${domainName}`;

// Frontend Stack - must be in us-east-1 for ACM certificate (CloudFront requirement)
const frontendStack = new FrontendStack(app, "MovieClubFrontendStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "us-east-1", // CloudFront + ACM require us-east-1
  },
  domainName: domainName,
  description: "Movie Club frontend hosting with CloudFront, S3, and WAF",
  crossRegionReferences: true, // Allow cross-region stack references
});

// Backend API Stack - deployed in us-west-2
const backendStack = new MovieClubStack(app, "MovieClubStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-west-2",
  },
  description: "Movie Club movie schedule management infrastructure",
  hostedZone: frontendStack.hostedZone,
  certificate: frontendStack.certificate,
  apiDomainName: apiDomainName,
  crossRegionReferences: true, // Allow cross-region stack references
});

// Ensure frontend stack deploys first
backendStack.addDependency(frontendStack);

app.synth();

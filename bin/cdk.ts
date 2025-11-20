#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { MovieClubStack } from "../lib/cdk-stack";

const app = new cdk.App();

new MovieClubStack(app, "MovieClubStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-west-2",
  },
  description: "Movie Club movie schedule management infrastructure",
});

app.synth();

# Deployment Guide

This document explains how to deploy the Movie Club Queue infrastructure and frontend.

## Prerequisites

1. **AWS Account** with appropriate permissions
2. **AWS CLI** configured with credentials
3. **Node.js 20.x** installed
4. **Domain registered** in Route 53: `movieclubqueue.com`

## Infrastructure Deployment (CDK)

### First-Time Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Bootstrap CDK** (only needed once per account/region):
   ```bash
   npx cdk bootstrap aws://ACCOUNT-ID/us-east-1
   npx cdk bootstrap aws://ACCOUNT-ID/us-west-2
   ```

3. **Deploy frontend stack** (CloudFront, S3, Route 53, ACM):
   ```bash
   npx cdk deploy MovieClubFrontendStack
   ```
   
   **Important:** After deployment, configure the domain nameservers:
   - Copy the nameservers from the CDK output
   - Update them in the Route 53 domain registration settings
   - Wait for DNS propagation (can take up to 48 hours, usually ~10 minutes)
   - ACM certificate validation will complete automatically via DNS

4. **Deploy backend stack** (API Gateway, Lambda, DynamoDB):
   ```bash
   npx cdk deploy MovieClubStack
   ```

5. **Configure secrets:**
   ```bash
   # Add TMDb API key to Secrets Manager
   aws secretsmanager put-secret-value \
     --secret-id movie-club/tmdb-api-key \
     --secret-string '{"TMDB_API_KEY":"your-tmdb-api-key-here"}' \
     --region us-west-2
   ```

6. **Retrieve API Key for admin operations:**
   ```bash
   # Get the API Key ID from CDK outputs
   API_KEY_ID=$(aws cloudformation describe-stacks \
     --stack-name MovieClubStack \
     --query 'Stacks[0].Outputs[?OutputKey==`APIKeyId`].OutputValue' \
     --output text \
     --region us-west-2)
   
   # Get the API Key value
   aws apigateway get-api-key \
     --api-key $API_KEY_ID \
     --include-value \
     --region us-west-2 \
     --query 'value' \
     --output text
   ```

### Updating Infrastructure

```bash
# Show what will change
npx cdk diff MovieClubFrontendStack
npx cdk diff MovieClubStack

# Deploy changes
npx cdk deploy --all
```

## Frontend Deployment (GitHub Actions)

### Setup GitHub Actions CI/CD

**Location:** The workflow file should be placed in the **frontend repository** at:
```
movie-club-queue-website/.github/workflows/deploy-frontend.yml
```

A sample workflow file is provided in this repository at `.github/workflows/deploy-frontend.yml`.

### Configure GitHub Secrets

In the frontend repository (`smithc10/movie-club-queue-website`), add these secrets:

1. Go to **Settings → Secrets and variables → Actions**
2. Add the following repository secrets:

   | Secret Name | Description | How to Get |
   |-------------|-------------|------------|
   | `AWS_ACCESS_KEY_ID` | IAM user access key | Create access key for `movie-club-github-actions` user in AWS Console |
   | `AWS_SECRET_ACCESS_KEY` | IAM user secret key | Same as above |
   | `S3_BUCKET_NAME` | S3 bucket name | From CDK output: `MovieClubFrontendBucket` |
   | `CLOUDFRONT_DISTRIBUTION_ID` | CloudFront distribution ID | From CDK output: `MovieClubDistributionId` |

### Create IAM Access Keys

```bash
# Create access keys for GitHub Actions user
aws iam create-access-key --user-name movie-club-github-actions

# Save the AccessKeyId and SecretAccessKey to GitHub Secrets
```

### Trigger Deployment

The workflow triggers automatically on:
- Push to `main` branch in the frontend repository
- Manual trigger via GitHub Actions UI

### Manual Deployment (Alternative)

If you prefer to deploy manually without GitHub Actions:

```bash
# In the frontend repository (movie-club-queue-website)
npm install
npm run build

# Sync to S3
aws s3 sync dist/ s3://movieclubqueue.com-frontend \
  --delete \
  --cache-control "public, max-age=31536000, immutable" \
  --exclude "index.html"

aws s3 cp dist/index.html s3://movieclubqueue.com-frontend/index.html \
  --cache-control "public, max-age=0, must-revalidate"

# Invalidate CloudFront cache
aws cloudfront create-invalidation \
  --distribution-id YOUR_DISTRIBUTION_ID \
  --paths "/*"
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         movieclubqueue.com                      │
│                                                                 │
│  ┌──────────────┐      ┌─────────────┐      ┌──────────────┐  │
│  │   Route 53   │─────▶│  CloudFront │◀────▶│  S3 Bucket   │  │
│  │              │      │ + WAF       │      │  (Frontend)  │  │
│  └──────────────┘      └─────────────┘      └──────────────┘  │
│                                                                 │
│                    api.movieclubqueue.com                       │
│                                                                 │
│  ┌──────────────┐      ┌─────────────┐      ┌──────────────┐  │
│  │   Route 53   │─────▶│API Gateway  │◀────▶│   Lambda     │  │
│  │              │      │  + X-Ray    │      │  Functions   │  │
│  └──────────────┘      └─────────────┘      └──────┬───────┘  │
│                                                     │          │
│                                    ┌────────────────┼──────┐   │
│                                    │                │      │   │
│                                    ▼                ▼      ▼   │
│                              ┌──────────┐  ┌──────────────┐   │
│                              │ DynamoDB │  │   Secrets    │   │
│                              │          │  │   Manager    │   │
│                              └──────────┘  └──────────────┘   │
└─────────────────────────────────────────────────────────────────┘

Region Split:
- Frontend Stack: us-east-1 (required for CloudFront + ACM)
- Backend Stack: us-west-2 (configurable via CDK_DEFAULT_REGION)
```

## Security Features

### Frontend (CloudFront + WAF)
- ✅ HTTPS only (TLS 1.2+)
- ✅ Security headers (HSTS, CSP, X-Frame-Options, etc.)
- ✅ AWS WAF with managed rules:
  - Core Rule Set (CRS)
  - Known Bad Inputs protection
  - Rate limiting (2000 req/5min per IP)
- ✅ CloudFront access logs
- ✅ S3 bucket private (CloudFront OAC)

### Backend (API Gateway + Lambda)
- ✅ X-Ray tracing enabled
- ✅ API Key authentication for write operations
- ✅ Rate limiting (100 req/s, burst 200)
- ✅ Monthly quota (10,000 requests)
- ✅ Lambda least-privilege IAM role
- ✅ Secrets in Secrets Manager (not env vars)
- ✅ DynamoDB ConditionalExpression for duplicate prevention

## Monitoring

### CloudWatch Logs
- Lambda function logs: `/aws/lambda/MovieClubStack-*`
- API Gateway logs: (disabled - requires account-level setup)

### X-Ray Traces
- View end-to-end request traces in AWS X-Ray console
- Traces available for both Lambda functions and API Gateway

### CloudFront Logs
- S3 bucket: `movieclubqueue.com-cloudfront-logs`
- Prefix: `cloudfront-logs/`
- Retention: 90 days

## Costs (Estimated)

**Monthly costs for low-traffic club (~100 members, ~500 requests/month):**

| Service | Cost |
|---------|------|
| Route 53 Hosted Zone | $0.50 |
| CloudFront (1GB data) | $0.09 |
| S3 Storage (1GB) | $0.02 |
| AWS WAF | $5.00 |
| API Gateway (500 requests) | $0.00 (free tier) |
| Lambda (500 invocations) | $0.00 (free tier) |
| DynamoDB (minimal usage) | $0.00 (free tier) |
| ACM Certificate | $0.00 (free) |
| **Total** | **~$5.61/month** |

**Note:** WAF is the primary cost driver. Can be removed if not needed, reducing cost to ~$0.61/month.

## Troubleshooting

### Certificate validation stuck
- Check nameservers are configured correctly in Route 53 domain settings
- Wait for DNS propagation (can take up to 48 hours)
- Check certificate status: `aws acm describe-certificate --certificate-arn ARN`

### CloudFront not serving updated content
- Ensure you ran `create-invalidation` after uploading to S3
- Check cache-control headers on S3 objects
- Try hard refresh in browser (Ctrl+Shift+R)

### API Gateway 403 errors
- Check if API Key is required and provided in `X-Api-Key` header
- Verify API Key is valid and associated with usage plan
- Check WAF rules aren't blocking requests

### Lambda errors
- Check CloudWatch Logs for function errors
- Verify TMDb API key is set in Secrets Manager
- Check X-Ray traces for detailed error information

## Cleanup

To delete all resources:

```bash
# Delete stacks (keeps DynamoDB table due to RETAIN policy)
npx cdk destroy --all

# Manually delete S3 buckets if needed
aws s3 rb s3://movieclubqueue.com-frontend --force
aws s3 rb s3://movieclubqueue.com-cloudfront-logs --force

# Manually delete DynamoDB table if needed
aws dynamodb delete-table --table-name club-schedule --region us-west-2
```

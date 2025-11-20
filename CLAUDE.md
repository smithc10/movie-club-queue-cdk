# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Phase 1: Single-Club Serverless MVP**

Movie Club Queue CDK - AWS infrastructure as code for a movie club scheduling system. This project uses AWS CDK to deploy infrastructure for managing a weekly movie discussion queue.

**Technology Stack:**
- AWS CDK for Infrastructure as Code
- DynamoDB for data storage
- AWS Lambda for backend logic
- API Gateway for REST API
- CloudFront + S3 for frontend hosting
- Route 53 for DNS management
- AWS WAF for security
- ACM for SSL/TLS certificates
- Secrets Manager for TMDb API key

**Workspace Structure:**
```
/movie-club-queue-cdk (this repository)
├── /api                             - Lambda function code (backend logic)
│   ├── /get-schedule                - GET /movies - Retrieve movie schedule
│   ├── /add-movie                   - POST /movies - Add movie to queue
│   └── /shared                      - Shared services (TMDb, Secrets Manager)
├── /lib                             - CDK stack definition
├── /bin                             - CDK app entry point
└── /test                            - (Removed - use `cdk synth` for validation)
```

**Future Proofing:** The DynamoDB partition key (`tmdb_id`) is designed to be easily extended to a composite key (`ClubID` + `tmdb_id`) in Phase 2 for multi-club support.

## Build & Development Commands

### Building
- `npm run build` - Compile TypeScript to JavaScript
- `npm run watch` - Watch mode for continuous compilation

### Testing
- `npm run test` - Validate CDK stack via synthesis (runs `cdk synth`)

### CDK Operations
- `npx cdk synth` - Synthesize CloudFormation template (useful for validation)
- `npx cdk diff` - Show diff between deployed stack and current code
- `npx cdk deploy` - Deploy stack to AWS (requires AWS credentials configured)
- `npx cdk destroy` - Delete deployed stack

## Architecture

### Entry Point
The CDK app entry point is `bin/cdk.ts` (configured in cdk.json):
- Deploys **two stacks** in different regions:
  - `MovieClubFrontendStack` in us-east-1 (CloudFront + ACM requirement)
  - `MovieClubStack` in us-west-2 (or `CDK_DEFAULT_REGION`)
- Cross-region references enabled for shared resources (Route 53, ACM)

### Stack Structure

#### Frontend Stack (lib/frontend-stack.ts)

The `MovieClubFrontendStack` manages frontend hosting and DNS:

**Deployed Resources:**
1. **S3 Bucket** - Frontend assets storage
   - Private bucket with versioning enabled
   - Accessed via CloudFront Origin Access Control (OAC)
   - Lifecycle policy: delete old versions after 90 days
   - Separate bucket for CloudFront logs

2. **CloudFront Distribution** - CDN
   - Custom domain: `movieclubqueue.com` and `www.movieclubqueue.com`
   - TLS 1.2+ only, HTTP → HTTPS redirect
   - Security headers via CloudFront Function
   - SPA routing (404/403 → index.html)
   - Caching optimized for static assets
   - Integrated with AWS WAF

3. **Route 53 Hosted Zone** - DNS management
   - Manages DNS for `movieclubqueue.com`
   - A records for apex domain and www subdomain
   - A record for API subdomain (`api.movieclubqueue.com`)

4. **ACM Certificate** - SSL/TLS
   - Covers `movieclubqueue.com`, `www.movieclubqueue.com`, and `*.movieclubqueue.com`
   - DNS validation (automated)
   - Must be in us-east-1 for CloudFront

5. **AWS WAF Web ACL** - Security
   - AWS Managed Rules: Core Rule Set
   - AWS Managed Rules: Known Bad Inputs
   - Rate limiting: 2000 requests per 5 minutes per IP
   - CloudWatch metrics enabled

6. **IAM User** - GitHub Actions deployment
   - User: `movie-club-github-actions`
   - Permissions: S3 read/write, CloudFront invalidation

**Security Headers (via CloudFront Function):**
- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Content-Security-Policy` (configured for frontend needs)

#### Backend Stack (lib/cdk-stack.ts)

The `MovieClubStack` defines backend API infrastructure:

**Currently Deployed:**
1. **DynamoDB Table** (`club-schedule`)
   - Partition key: `tmdb_id` (NUMBER)
   - Pay-per-request billing
   - Point-in-time recovery enabled
   - Global Secondary Index: `discussion-date-index` (partition: `status`, sort: `discussion_date`)

2. **Secrets Manager** - TMDb API key storage (`movie-club/tmdb-api-key`)
   - Note: Secret value must be manually added post-deployment

3. **IAM Role** - Lambda execution role following principle of least privilege:
   - DynamoDB read/write access
   - Secrets Manager read-only access for TMDb API key

4. **Lambda Functions:**
   - `GetScheduleFunction` (GET /movies) - Retrieve full schedule with TMDb enrichment
     - Entry: `./api/get-schedule/index.ts`
     - Runtime: Node.js 20.x
     - Timeout: 30s (for TMDb API calls)
     - Memory: 512 MB
     - X-Ray tracing enabled
   - `AddMovieFunction` (POST /movies) - Add movie to queue with TMDb data
     - Entry: `./api/add-movie/index.ts`
     - Runtime: Node.js 20.x
     - Timeout: 10s
     - X-Ray tracing enabled
   - **Shared Services** (`./api/shared/`):
     - `secrets-manager.ts` - TMDb API key retrieval with caching
     - `tmdb.ts` - TMDb API integration (fetchMovieFromTmdb)
     - `types.ts` - TypeScript type definitions

5. **API Gateway REST API:**
   - Stage: v1
   - **Custom Domain:** `api.movieclubqueue.com` (optional, configured via frontend stack)
   - **Public endpoints:** 
     - GET /movies - Retrieve movie schedule (no auth required)
   - **Secured endpoints:** 
     - POST /movies - Add movie to queue (API Key required)
   - Rate limiting: 100 req/s (burst: 200)
   - Monthly quota: 10,000 requests
   - CORS enabled for `https://movieclubqueue.com` and `https://www.movieclubqueue.com`
   - X-Ray tracing enabled
   - CloudWatch logging disabled (requires account-level IAM role setup)

**Not Yet Implemented:**
- PUT/DELETE /movies endpoints (future CRUD operations)
- GET /search endpoint (TMDb search - not needed yet, uses direct TMDb IDs)
- Amazon Cognito (will replace API Key authentication)

### Data Model
Movies are stored with:
- `tmdb_id` - Primary key (The Movie Database ID)
- `status` - Used for GSI queries (e.g., "scheduled", "watched")
- `discussion_date` - Sort key in GSI for chronological ordering

## Important Notes

### Deployment Considerations
- The stack has `RemovalPolicy.RETAIN` on the DynamoDB table - table data persists even if stack is deleted
- AWS credentials must be configured before deployment
- After deployment, manually add the TMDb API key to Secrets Manager via AWS Console:
  - Key name: `movie-club/tmdb-api-key`
  - Format: JSON with key `TMDB_API_KEY` (e.g., `{"TMDB_API_KEY": "your-key-here"}`)
- After deployment, retrieve the API Key value from AWS Console for admin operations
- X-Ray tracing is enabled - view traces in AWS X-Ray console for debugging

### Security Model
- **Public endpoints:** GET /movies is publicly accessible (no authentication)
- **Secured endpoints:** POST /movies requires API Key authentication (X-Api-Key header)
- **Secrets:** TMDb API key retrieved at runtime from Secrets Manager with module-scope caching
  - Never bundled in Lambda code or environment variables
  - Cached across warm Lambda starts for performance
- **IAM:** Lambda execution role has least-privilege access:
  - DynamoDB: Read/write on `club-schedule` table only
  - Secrets Manager: Read-only on `movie-club/tmdb-api-key` only
  - CloudWatch Logs: Write via AWSLambdaBasicExecutionRole
  - X-Ray: Write traces for debugging
- **DynamoDB:** ConditionalExpression prevents duplicate movies atomically
- **API Gateway:** Rate limiting (100 req/s) and monthly quota (10k req/month)

### Environment Configuration
- Account/region come from AWS environment variables (`CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION`)

### TypeScript Configuration
- Module system: NodeNext (ES modules)
- Target: ES2022
- Strict mode enabled with null checks
- Source maps inlined for debugging

## Implementation Details

### Lambda Performance Optimizations
- **AWS Client Initialization:** All AWS clients (DynamoDB, Secrets Manager) are initialized at module scope, not inside handlers
  - Clients are reused across Lambda warm starts for better performance
  - Reduces cold start impact
- **Secret Caching:** TMDb API key is cached in module-scope variable after first retrieval
  - Eliminates redundant Secrets Manager calls on warm starts
  - Logged to CloudWatch when cache is used vs. fresh fetch

### Error Handling
- **Duplicate Prevention:** DynamoDB ConditionalExpression (`attribute_not_exists(tmdb_id)`) prevents duplicate movies
  - Returns 409 Conflict if movie already exists
  - Single atomic operation (no separate read + write)
- **TMDb Integration:** 
  - 404 from TMDb API returns 404 to client (movie not found)
  - Other TMDb errors return 500 (failed to fetch movie data)
- **Validation:** API Gateway + Lambda validates required fields (tmdb_id, discussion_date, status)

### Testing Strategy
- **CDK Validation:** `npm run test` runs `cdk synth` to validate CloudFormation template
- **No Unit Tests:** Team decided CDK tests were redundant; rely on synthesis + deployment validation
- **Manual Testing:** Use API Gateway endpoints with tools like curl/Postman
- **Observability:** X-Ray traces provide end-to-end request flow debugging

## Deployment

### Infrastructure Deployment

1. **Deploy Frontend Stack** (must deploy first):
   ```bash
   npx cdk deploy MovieClubFrontendStack
   ```
   - Creates Route 53 hosted zone, ACM certificate, CloudFront, S3, WAF
   - **Action Required:** Configure domain nameservers in Route 53 domain registration
   - Wait for ACM certificate DNS validation to complete (~5-10 minutes)

2. **Deploy Backend Stack:**
   ```bash
   npx cdk deploy MovieClubStack
   ```
   - Creates DynamoDB, Lambda functions, API Gateway with custom domain
   - **Action Required:** Add TMDb API key to Secrets Manager
   - **Action Required:** Retrieve API Key from AWS Console for admin operations

3. **Both Stacks:**
   ```bash
   npx cdk deploy --all
   ```

See `DEPLOYMENT.md` for detailed deployment instructions.

### Frontend Deployment (CI/CD)

**GitHub Actions Workflow:** `.github/workflows/deploy-frontend.yml`

**Location:** This workflow should be placed in the **frontend repository** (`movie-club-queue-website`)

**Triggers:**
- Automatic: Push to `main` branch
- Manual: GitHub Actions UI

**Required GitHub Secrets** (in frontend repository):
- `AWS_ACCESS_KEY_ID` - IAM user access key (movie-club-github-actions)
- `AWS_SECRET_ACCESS_KEY` - IAM user secret key
- `S3_BUCKET_NAME` - From CDK output: `MovieClubFrontendBucket`
- `CLOUDFRONT_DISTRIBUTION_ID` - From CDK output: `MovieClubDistributionId`

**Workflow Steps:**
1. Checkout frontend code
2. Install dependencies (`npm ci`)
3. Build Vite app (`npm run build`)
4. Sync `dist/` to S3 with caching headers
5. Invalidate CloudFront cache

**Manual Deployment Alternative:**
```bash
# Build frontend
cd movie-club-queue-website
npm run build

# Deploy to S3
aws s3 sync dist/ s3://movieclubqueue.com-frontend --delete

# Invalidate CloudFront
aws cloudfront create-invalidation \
  --distribution-id DISTRIBUTION_ID \
  --paths "/*"
```

### URLs
- **Frontend:** https://movieclubqueue.com (and https://www.movieclubqueue.com)
- **API:** https://api.movieclubqueue.com (or default API Gateway URL if custom domain not configured)

### Monitoring
- **CloudFront Logs:** S3 bucket `movieclubqueue.com-cloudfront-logs`
- **Lambda Logs:** CloudWatch `/aws/lambda/MovieClubStack-*`
- **X-Ray Traces:** AWS X-Ray console (us-west-2)
- **WAF Metrics:** CloudWatch (us-east-1)

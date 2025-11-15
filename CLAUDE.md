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
- AWS Amplify Hosting for frontend (planned)
- Secrets Manager for TMDb API key

**Workspace Structure:**
```
/film-club-workspace-dir
├── /cdk-repo (this repository)     - CDK infrastructure code
├── /api                             - Lambda function code (backend logic)
│   ├── /get-movies                  - Retrieve movie schedule
│   ├── /manage-movie                - CRUD operations
│   └── /search-movie                - TMDb search integration
└── /frontend-repo                   - React app (separate repository)
```

**Future Proofing:** The DynamoDB partition key (`tmdb_id`) is designed to be easily extended to a composite key (`ClubID` + `tmdb_id`) in Phase 2 for multi-club support.

## Build & Development Commands

### Building
- `npm run build` - Compile TypeScript to JavaScript
- `npm run watch` - Watch mode for continuous compilation

### Testing
- `npm run test` - Run Jest unit tests

### CDK Operations
- `npx cdk synth` - Synthesize CloudFormation template (useful for validation)
- `npx cdk diff` - Show diff between deployed stack and current code
- `npx cdk deploy` - Deploy stack to AWS (requires AWS credentials configured)
- `npx cdk destroy` - Delete deployed stack

## Architecture

### Entry Point
The CDK app entry point is `bin/cdk.ts` (configured in cdk.json):
- Deploys to configured AWS region (via `CDK_DEFAULT_REGION` environment variable)
- Stack ID: "MovieClubStack"

### Stack Structure (lib/cdk-stack.ts)

The `MovieClubStack` defines infrastructure in a phased approach:

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

**Commented Out (Future Implementation):**
- **Lambda Functions:**
  - `GetMovies` (GET /movies) - Retrieve full schedule with TMDb enrichment
  - `ManageMovie` (POST/PUT/DELETE /movies) - CRUD operations for queue management
  - `SearchMovie` (GET /search) - TMDb API integration for movie lookup
  - Each function will have its own directory with package.json in `/api`
- **API Gateway REST API:**
  - Public endpoints: GET /movies, GET /search
  - Secured endpoints: POST/PUT/DELETE /movies (API Key required)
  - API Key authentication protects write operations for admin users
- **AWS Amplify Hosting:**
  - Frontend deployment linked to Git repository
  - React app for movie queue management UI

### Data Model
Movies are stored with:
- `tmdb_id` - Primary key (The Movie Database ID)
- `status` - Used for GSI queries (e.g., "scheduled", "watched")
- `discussion_date` - Sort key in GSI for chronological ordering

## Important Notes

### Deployment Considerations
- The stack has `RemovalPolicy.RETAIN` on the DynamoDB table - table data persists even if stack is deleted
- AWS credentials must be configured before deployment
- After deployment, manually add the TMDb API key to Secrets Manager via AWS Console
- Most Lambda/API Gateway code is currently commented out - uncomment as needed for incremental deployment

### Security Model
- **Public endpoints:** Read operations (GET /movies, GET /search) are publicly accessible
- **Secured endpoints:** Write operations (POST/PUT/DELETE) require API Key authentication
- **Secrets:** TMDb API key retrieved at runtime from Secrets Manager (never bundled in code)
- **IAM:** Lambda functions have least-privilege access to only required resources

### Environment Configuration
- Account/region come from AWS environment variables (`CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION`)

### TypeScript Configuration
- Module system: NodeNext (ES modules)
- Target: ES2022
- Strict mode enabled with null checks
- Source maps inlined for debugging

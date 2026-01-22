import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as iam from "aws-cdk-lib/aws-iam";

export interface MovieClubWebsiteStackProps extends cdk.StackProps {
  domainName: string; // e.g., "movieclubqueue.com"
}

export class MovieClubWebsiteStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly bucket: s3.Bucket;
  public readonly hostedZone: route53.PublicHostedZone;
  public readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: MovieClubWebsiteStackProps) {
    super(scope, id, props);

    const { domainName } = props;

    // ===== STEP 1: S3 Bucket for Frontend Assets =====
    this.bucket = new s3.Bucket(this, "FrontendBucket", {
      bucketName: `${cdk.Stack.of(this).stackName.toLowerCase()}-website-prod`,
      versioned: true, // Enable versioning for rollback capability
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // Private bucket
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Keep bucket if stack is deleted
      autoDeleteObjects: false, // Don't auto-delete on stack deletion
      lifecycleRules: [
        {
          // Clean up old versions after 90 days
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
      ],
    });

    // ===== STEP 2: Route 53 Hosted Zone =====
    // Import existing hosted zone (domain must be registered in Route 53)
    this.hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: domainName,
    }) as route53.PublicHostedZone;

    // ===== STEP 3: ACM Certificate (us-east-1 required for CloudFront) =====
    // https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_certificatemanager.Certificate.html
    // Note: This certificate is created in us-east-1 because the entire stack is deployed there (see bin/cdk.ts)
    // CloudFront requires ACM certificates to be in us-east-1
    this.certificate = new acm.Certificate(this, "Certificate", {
      domainName: domainName,
      subjectAlternativeNames: [`www.${domainName}`, `*.${domainName}`],
      validation: acm.CertificateValidation.fromDns(this.hostedZone),
    });

    // ===== STEP 4: Response Headers Policy for Security Headers =====
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      "SecurityHeadersPolicy",
      {
        responseHeadersPolicyName: "MovieClubSecurityHeaders",
        comment: "Security headers for Movie Club Queue website",
        securityHeadersBehavior: {
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.seconds(31536000),
            includeSubdomains: true,
            preload: true,
            override: true,
          },
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          xssProtection: {
            protection: true,
            modeBlock: true,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy:
              cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
          contentSecurityPolicy: {
            contentSecurityPolicy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://image.tmdb.org; font-src 'self' data:; connect-src 'self' https://api.${domainName} https://cognito-idp.us-west-2.amazonaws.com https://*.auth.us-west-2.amazoncognito.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://*.auth.us-west-2.amazoncognito.com; object-src 'none';`,
            override: true,
          },
        },
        customHeadersBehavior: {
          customHeaders: [
            {
              header: "Permissions-Policy",
              value:
                "geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=()",
              override: true,
            },
          ],
        },
      },
    );

    // ===== STEP 5: AWS WAF Web ACL =====
    const webAcl = new wafv2.CfnWebACL(this, "WebACL", {
      scope: "CLOUDFRONT", // Must be CLOUDFRONT for CloudFront distributions
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "MovieClubWebACL",
        sampledRequestsEnabled: true,
      },
      rules: [
        // AWS Managed Rule: Core Rule Set
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 1,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesCommonRuleSetMetric",
            sampledRequestsEnabled: true,
          },
        },
        // AWS Managed Rule: Known Bad Inputs
        {
          name: "AWSManagedRulesKnownBadInputsRuleSet",
          priority: 2,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesKnownBadInputsRuleSet",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesKnownBadInputsRuleSetMetric",
            sampledRequestsEnabled: true,
          },
        },
        // Rate Limiting: 200 requests per 5 minutes per IP (40 req/min)
        {
          name: "RateLimitRule",
          priority: 3,
          statement: {
            rateBasedStatement: {
              limit: 200,
              aggregateKeyType: "IP",
            },
          },
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "RateLimitRuleMetric",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // ===== STEP 6: CloudFront Distribution =====
    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "Movie Club Queue Frontend Distribution",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: responseHeadersPolicy,
      },
      domainNames: [domainName, `www.${domainName}`],
      certificate: this.certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultRootObject: "index.html",
      errorResponses: [
        {
          // SPA routing: redirect 404s to index.html for client-side routing
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(5),
        },
      ],
      webAclId: webAcl.attrArn,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // North America & Europe only
      enableLogging: true,
      logBucket: new s3.Bucket(this, "CloudFrontLogBucket", {
        bucketName: `${cdk.Stack.of(this).stackName.toLowerCase()}-cloudfront-logs`,
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        lifecycleRules: [
          {
            expiration: cdk.Duration.days(90), // Delete logs after 90 days
          },
        ],
      }),
      logFilePrefix: "cloudfront-logs/",
    });

    // ===== STEP 7: Route 53 DNS Records =====
    // A record for apex domain (movieclubqueue.com)
    new route53.ARecord(this, "ApexARecord", {
      zone: this.hostedZone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution),
      ),
      comment: "Alias to CloudFront distribution",
    });

    // A record for www subdomain
    new route53.ARecord(this, "WwwARecord", {
      zone: this.hostedZone,
      recordName: `www.${domainName}`,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution),
      ),
      comment: "Alias to CloudFront distribution (www subdomain)",
    });

    // ===== Outputs =====
    new cdk.CfnOutput(this, "BucketName", {
      value: this.bucket.bucketName,
      description: "S3 bucket name for frontend assets",
      exportName: "MovieClubFrontendBucket",
    });

    new cdk.CfnOutput(this, "DistributionId", {
      value: this.distribution.distributionId,
      description: "CloudFront distribution ID",
      exportName: "MovieClubDistributionId",
    });

    new cdk.CfnOutput(this, "DistributionDomainName", {
      value: this.distribution.distributionDomainName,
      description: "CloudFront distribution domain name",
      exportName: "MovieClubDistributionDomain",
    });

    new cdk.CfnOutput(this, "WebsiteURL", {
      value: `https://${domainName}`,
      description: "Website URL",
      exportName: "MovieClubWebsiteURL",
    });

    new cdk.CfnOutput(this, "HostedZoneId", {
      value: this.hostedZone.hostedZoneId,
      description: "Route 53 Hosted Zone ID",
      exportName: "MovieClubHostedZoneId",
    });
  }
}

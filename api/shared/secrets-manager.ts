import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

// Cached secrets (persists across warm starts)
let cachedTmdbApiKey: string | null = null;

// Secrets Manager client (initialized once and reused across invocations)
const secretsClient = new SecretsManagerClient({});

/**
 * Retrieves TMDb API key from Secrets Manager with caching
 */
export async function getTmdbApiKey(secretArn: string): Promise<string> {
  if (cachedTmdbApiKey) {
    console.log("Using cached TMDb API key");
    return cachedTmdbApiKey;
  }

  console.log("Fetching TMDb API key from Secrets Manager");

  try {
    const command = new GetSecretValueCommand({
      SecretId: secretArn,
    });

    const response = await secretsClient.send(command);

    if (!response.SecretString) {
      throw new Error("Secret value is empty");
    }

    // Parse secret (stored as JSON with "TMDB_API_KEY" field)
    let apiKey: string;
    try {
      const secret = JSON.parse(response.SecretString);
      apiKey = secret.TMDB_API_KEY;
    } catch {
      // If not JSON, treat as plain string
      apiKey = response.SecretString;
    }

    if (!apiKey) {
      throw new Error("API key not found in secret");
    }

    // Cache for future invocations
    cachedTmdbApiKey = apiKey;
    console.log("TMDb API key cached successfully");

    return apiKey;
  } catch (error) {
    console.error("Failed to retrieve TMDb API key:", error);
    throw new Error("Failed to retrieve TMDb API key from Secrets Manager");
  }
}

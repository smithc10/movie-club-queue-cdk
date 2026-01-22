import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type {
  AddMovieRequest,
  MovieItem,
  TMDbMovieResponse,
} from "../shared/types";
import {
  ValidationError,
  MovieNotFoundError,
  MovieAlreadyExistsError,
} from "../shared/types";
import { getTmdbApiKey } from "../shared/secrets-manager";
import { fetchMovieFromTmdb } from "../shared/tmdb";

// Environment variables
const TABLE_NAME = process.env.TABLE_NAME!;
const TMDB_SECRET_ARN = process.env.TMDB_SECRET_ARN!;

// AWS clients (initialized once and reused across invocations)
const dynamoClient = new DynamoDBClient({});

/**
 * Lambda handler for POST /movies
 * Adds a new movie to the schedule with TMDb validation
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  // Extract user info from Cognito JWT claims
  const claims = event.requestContext.authorizer?.claims;
  const userEmail = claims?.email as string | undefined;

  console.log("POST /movies request received", {
    body: event.body,
    user: userEmail,
  });

  try {
    // Parse and validate request body
    const body: AddMovieRequest = JSON.parse(event.body || "{}");
    validateRequest(body);

    // Fetch and validate movie from TMDb
    const tmdbApiKey = await getTmdbApiKey(TMDB_SECRET_ARN);
    const tmdbMovie = await fetchMovieFromTmdb(body.tmdb_id, tmdbApiKey);

    // Create movie item with TMDb data
    const movieItem = createMovieItem(body, tmdbMovie, userEmail);

    // Store in DynamoDB (with conditional check to prevent duplicates)
    await saveMovieToDynamoDB(dynamoClient, movieItem);

    console.log(`Movie ${body.tmdb_id} added successfully`);

    // Return success response
    return {
      statusCode: 201,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        success: true,
        movie: movieItem,
        message: "Movie successfully added to schedule",
      }),
    };
  } catch (error) {
    console.error("Error in add-movie:", error);

    // Handle validation errors
    if (error instanceof ValidationError) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Validation error",
          message: error.message,
        }),
      };
    }

    // Handle movie already exists
    if (error instanceof MovieAlreadyExistsError) {
      return {
        statusCode: 409,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Conflict",
          message: error.message,
        }),
      };
    }

    // Handle movie not found in TMDb
    if (error instanceof MovieNotFoundError) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Not found",
          message: error.message,
        }),
      };
    }

    // Handle all other errors
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    };
  }
};

/**
 * Validates the add movie request
 */
function validateRequest(body: AddMovieRequest): void {
  // Validate tmdb_id
  if (!body.tmdb_id || typeof body.tmdb_id !== "number") {
    throw new ValidationError("tmdb_id is required and must be a number");
  }

  if (body.tmdb_id <= 0) {
    throw new ValidationError("tmdb_id must be a positive number");
  }

  // Validate discussion_date
  if (!body.discussion_date || typeof body.discussion_date !== "string") {
    throw new ValidationError(
      "discussion_date is required and must be a string",
    );
  }

  // Validate date format (YYYY-MM-DD)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(body.discussion_date)) {
    throw new ValidationError("discussion_date must be in YYYY-MM-DD format");
  }

  // Validate date is valid
  const discussionDate = new Date(body.discussion_date);
  if (isNaN(discussionDate.getTime())) {
    throw new ValidationError("discussion_date is not a valid date");
  }

  // Validate status (if provided)
  if (body.status && !["scheduled", "watched"].includes(body.status)) {
    throw new ValidationError("status must be either 'scheduled' or 'watched'");
  }

  // Validate notes (if provided)
  if (body.notes && body.notes.length > 1000) {
    throw new ValidationError("notes must be less than 1000 characters");
  }
}

/**
 * Creates a MovieItem from the request and TMDb data
 */
function createMovieItem(
  request: AddMovieRequest,
  tmdbMovie: TMDbMovieResponse,
  addedBy?: string,
): MovieItem {
  const now = new Date().toISOString();

  return {
    tmdb_id: request.tmdb_id,
    status: request.status || "scheduled",
    discussion_date: request.discussion_date,
    title: tmdbMovie.title,
    original_title: tmdbMovie.original_title,
    overview: tmdbMovie.overview,
    poster_path: tmdbMovie.poster_path || undefined,
    backdrop_path: tmdbMovie.backdrop_path || undefined,
    release_date: tmdbMovie.release_date,
    runtime: tmdbMovie.runtime,
    genres: tmdbMovie.genres,
    vote_average: tmdbMovie.vote_average,
    vote_count: tmdbMovie.vote_count,
    notes: request.notes,
    added_by: addedBy,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Saves the movie item to DynamoDB with conditional check to prevent duplicates
 */
async function saveMovieToDynamoDB(
  dynamoClient: DynamoDBClient,
  movieItem: MovieItem,
): Promise<void> {
  try {
    const command = new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(movieItem, { removeUndefinedValues: true }),
      ConditionExpression: "attribute_not_exists(tmdb_id)",
    });

    await dynamoClient.send(command);
    console.log(`Movie ${movieItem.tmdb_id} saved to DynamoDB`);
  } catch (error: any) {
    // Handle conditional check failure (movie already exists)
    if (error.name === "ConditionalCheckFailedException") {
      throw new MovieAlreadyExistsError(movieItem.tmdb_id);
    }
    console.error("Error saving movie to DynamoDB:", error);
    throw new Error("Failed to save movie to database");
  }
}

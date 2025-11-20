import {
  DynamoDBClient,
  QueryCommand,
  QueryCommandInput,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type { MovieItem, TMDbMovieResponse } from "../shared/types";
import { getTmdbApiKey } from "../shared/secrets-manager";
import { fetchMovieFromTmdb, TMDB_IMAGE_BASE_URL } from "../shared/tmdb";

// Environment variables
const TABLE_NAME = process.env.TABLE_NAME!;
const TMDB_SECRET_ARN = process.env.TMDB_SECRET_ARN!;
const DISCUSSION_DATE_INDEX = process.env.DISCUSSION_DATE_INDEX!;

// AWS clients (initialized once and reused across invocations)
const dynamoClient = new DynamoDBClient({});

/**
 * Lambda handler for GET /movies
 * Retrieves scheduled movies and enriches with TMDb data
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.log("GET /movies request received", {
    queryParams: event.queryStringParameters,
  });

  try {
    // Get TMDb API key (cached after first retrieval)
    const tmdbApiKey = await getTmdbApiKey(TMDB_SECRET_ARN);

    // Query DynamoDB for scheduled movies
    const movies = await getScheduledMovies(dynamoClient);

    console.log(`Retrieved ${movies.length} movies from DynamoDB`);

    // Enrich with TMDb data
    const enrichedMovies = await enrichMoviesWithTmdb(movies, tmdbApiKey);

    // Return response
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        movies: enrichedMovies,
        count: enrichedMovies.length,
      }),
    };
  } catch (error) {
    console.error("Error in get-schedule:", error);
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
 * Queries DynamoDB for scheduled movies ordered by discussion date
 */
async function getScheduledMovies(
  dynamoClient: DynamoDBClient,
): Promise<MovieItem[]> {
  const queryInput: QueryCommandInput = {
    TableName: TABLE_NAME,
    IndexName: DISCUSSION_DATE_INDEX,
    KeyConditionExpression: "#status = :status",
    ExpressionAttributeNames: {
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":status": { S: "scheduled" },
    },
    ScanIndexForward: true, // Ascending order by discussion_date
  };

  try {
    const command = new QueryCommand(queryInput);
    const response = await dynamoClient.send(command);

    if (!response.Items || response.Items.length === 0) {
      console.log("No scheduled movies found");
      return [];
    }

    // Unmarshall DynamoDB items to MovieItem objects
    const movies = response.Items.map((item) => unmarshall(item) as MovieItem);

    return movies;
  } catch (error) {
    console.error("Error querying DynamoDB:", error);
    throw new Error("Failed to retrieve movies from database");
  }
}

/**
 * Enriches movies with fresh TMDb data
 * Falls back to stored data if TMDb API fails
 */
async function enrichMoviesWithTmdb(
  movies: MovieItem[],
  apiKey: string,
): Promise<any[]> {
  const enrichedMovies = await Promise.all(
    movies.map(async (movie) => {
      try {
        // Fetch fresh data from TMDb
        const tmdbData = await fetchMovieFromTmdb(movie.tmdb_id, apiKey);

        // Merge TMDb data with stored data
        return {
          tmdb_id: movie.tmdb_id,
          title: tmdbData.title,
          overview: tmdbData.overview,
          poster_path: tmdbData.poster_path
            ? `${TMDB_IMAGE_BASE_URL}${tmdbData.poster_path}`
            : null,
          discussion_date: movie.discussion_date,
          status: movie.status,
          release_date: tmdbData.release_date,
          runtime: tmdbData.runtime,
          vote_average: tmdbData.vote_average,
          notes: movie.notes,
        };
      } catch (error) {
        console.warn(
          `Failed to enrich movie ${movie.tmdb_id} from TMDb, using stored data:`,
          error,
        );

        // Fallback to stored data
        return {
          tmdb_id: movie.tmdb_id,
          title: movie.title,
          overview: movie.overview,
          poster_path: movie.poster_path
            ? `${TMDB_IMAGE_BASE_URL}${movie.poster_path}`
            : null,
          discussion_date: movie.discussion_date,
          status: movie.status,
          release_date: movie.release_date,
          runtime: movie.runtime,
          vote_average: movie.vote_average,
          notes: movie.notes,
        };
      }
    }),
  );

  return enrichedMovies;
}

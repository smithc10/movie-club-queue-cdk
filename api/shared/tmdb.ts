import type { TMDbMovieResponse } from "./types";
import { MovieNotFoundError } from "./types";

// TMDb API configuration
const TMDB_API_BASE_URL = "https://api.themoviedb.org/3";
export const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500";

/**
 * Fetches movie details from TMDb API
 */
export async function fetchMovieFromTmdb(
  tmdbId: number,
  apiKey: string
): Promise<TMDbMovieResponse> {
  const url = `${TMDB_API_BASE_URL}/movie/${tmdbId}`;

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new MovieNotFoundError(tmdbId);
      }
      throw new Error(
        `TMDb API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as TMDbMovieResponse;
    return data;
  } catch (error) {
    if (error instanceof MovieNotFoundError) {
      throw error;
    }
    console.error(`Error fetching movie ${tmdbId} from TMDb:`, error);
    throw new Error("Failed to fetch movie from TMDb");
  }
}

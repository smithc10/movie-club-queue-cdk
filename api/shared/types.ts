// Shared TypeScript interfaces for Lambda functions

// DynamoDB Movie Item Schema
export interface MovieItem {
  // Primary Key
  tmdb_id: number; // Partition key (The Movie Database ID)

  // GSI Attributes
  status: "scheduled" | "watched" | "cancelled"; // GSI partition key
  discussion_date: string; // GSI sort key (ISO 8601: YYYY-MM-DD)

  // Movie Metadata (from TMDb API)
  title: string;
  original_title?: string;
  overview: string;
  poster_path?: string; // TMDb poster URL path
  backdrop_path?: string;
  release_date?: string; // YYYY-MM-DD
  runtime?: number; // Minutes
  genres?: Array<{ id: number; name: string }>;
  vote_average?: number;
  vote_count?: number;

  // Club-specific data
  added_by?: string; // User who added (future auth integration)
  notes?: string; // Club-specific notes

  // Timestamps
  created_at: string; // ISO 8601 timestamp
  updated_at: string; // ISO 8601 timestamp
}

// TMDb API Response Schema
export interface TMDbMovieResponse {
  id: number;
  title: string;
  original_title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string;
  runtime: number;
  genres: Array<{ id: number; name: string }>;
  vote_average: number;
  vote_count: number;
}

// API Request/Response Models
export interface AddMovieRequest {
  tmdb_id: number;
  discussion_date: string; // YYYY-MM-DD format
  status?: "scheduled" | "watched"; // Default: 'scheduled'
  notes?: string;
}

export interface GetScheduleResponse {
  movies: Array<{
    tmdb_id: number;
    title: string;
    overview: string;
    poster_path: string | null;
    discussion_date: string;
    status: string;
    release_date?: string;
    runtime?: number;
    vote_average?: number;
  }>;
  count: number;
  last_evaluated_key?: string; // For pagination
}

export interface AddMovieResponse {
  success: boolean;
  movie: MovieItem;
  message: string;
}

export interface ErrorResponse {
  error: string; // Error category
  message: string; // Human-readable message
  details?: any; // Additional context
}

// Custom Error Classes
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class MovieNotFoundError extends Error {
  constructor(tmdbId: number) {
    super(`Movie with TMDb ID ${tmdbId} not found`);
    this.name = "MovieNotFoundError";
  }
}

export class MovieAlreadyExistsError extends Error {
  constructor(tmdbId: number) {
    super(`Movie with TMDb ID ${tmdbId} already exists in the schedule`);
    this.name = "MovieAlreadyExistsError";
  }
}

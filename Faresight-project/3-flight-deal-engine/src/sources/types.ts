// Every fare source returns the same record, so the engine never knows which source produced it.
export interface FareQuery {
  origin: string;
  destination: string;
  depart: string;      // YYYY-MM-DD
  returnDate: string;  // YYYY-MM-DD
  maxStops: number;    // 0 nonstop, 1 up to one stop, 2 up to two
  currency: string;    // INR
  gl: string;          // Google market, e.g. in
}

export interface FareResult {
  price: number | null;        // cheapest within maxStops
  cheapestAny: number | null;  // cheapest with any stops
  stops: number | null;
  airlines: string | null;
  options: number;             // how many itineraries came back
  source: string;
  credits: number;
}

export interface FareSource {
  name: string;
  search(q: FareQuery): Promise<FareResult>;
}

/** Thrown for errors worth retrying later (rate limits, timeouts, 5xx). */
export class RetryableError extends Error { retryAfterMs = 5000; }
/** Thrown when retrying is pointless (bad token, out of credits). Stops the workers. */
export class FatalSourceError extends Error {}

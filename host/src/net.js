/**
 * Fetching toolchain assets over a network that sometimes says no.
 *
 * A distribution is ~35 MB across a dozen files on first load - `rt.jar` is 15 MB and the
 * compiler module 3.2 MB compressed - so a dropped connection partway through is an ordinary
 * event on the public internet, and worse in a private window where nothing is ever cached.
 *
 * `fetch` rejects a network failure with a `TypeError` whose entire message is "Failed to
 * fetch": no URL, no status. Every failure here names the asset instead, and anything that
 * might succeed on a second attempt gets one.
 */

/** Statuses worth trying again: a server or gateway hiccup, a rate limit, a timeout. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const RETRY_DELAYS_MS = [250, 1000];

/**
 * Fetch a toolchain asset, saying what failed and trying again when that might help.
 *
 * Two reasons this is not a bare `fetch`. First, a distribution is ~60 MB over the public
 * internet - `rt.jar` alone is 15 MB - so a dropped connection partway through is an ordinary
 * event, not a bug, and one retry usually settles it. Second, `fetch` rejects a network
 * failure with a `TypeError` whose entire message is "Failed to fetch": no URL, no status,
 * nothing to act on. Reading that in a bug report tells you only that something, somewhere,
 * did not load. Every failure here names the asset and what went wrong with it.
 */
async function fetchAsset(url, read, init) {
  let lastError;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        const error = new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
        if (!RETRYABLE_STATUS.has(response.status)) {
          // A 404 will still be a 404 in a second; marked so the catch below re-raises it
          // rather than sending us round the loop.
          throw Object.assign(error, { toolchainFetchFatal: true });
        }
        lastError = error;
        continue;
      }
      // The body can still fail mid-stream, which is the likeliest failure for the large
      // assets - so reading it is part of the attempt, not something after it.
      return await read(response);
    } catch (error) {
      // A non-retryable status, already described above.
      if (error?.toolchainFetchFatal) throw error;
      lastError = error;
    }
  }

  const attempts = RETRY_DELAYS_MS.length + 1;
  const detail = lastError?.message === "Failed to fetch"
    ? "the network request failed (no response); the connection may have dropped mid-download"
    : lastError?.message ?? String(lastError);
  throw new Error(`Could not load ${url} after ${attempts} attempts: ${detail}`, { cause: lastError });
}

export function fetchJSON(url) {
  return fetchAsset(url, response => response.json());
}

export async function fetchBytes(url) {
  return fetchAsset(url, async response => new Uint8Array(await response.arrayBuffer()));
}


/**
 * Fetch without reading the body, for callers that need to stream it.
 *
 * Retries cover connecting and the response headers; once a caller owns the body we cannot
 * retry behind its back, so a mid-stream failure surfaces to it. Naming the asset still
 * applies, which is the difference between a diagnosable report and "Failed to fetch".
 */
export function fetchResponse(url, init) {
  return fetchAsset(url, response => response, init);
}

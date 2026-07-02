const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Semaphore {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.currentConcurrent = 0;
    this.waitingQueue = [];
  }

  async acquire() {
    if (this.currentConcurrent < this.maxConcurrent) {
      this.currentConcurrent++;
      return;
    }
    return new Promise(resolve => this.waitingQueue.push(resolve));
  }

  release() {
    if (this.waitingQueue.length > 0) {
      const resolve = this.waitingQueue.shift();
      resolve();
    } else {
      this.currentConcurrent--;
    }
  }
}

// Global semaphore: limit maximum concurrent outgoing HTTP requests across the entire Node process.
// This acts as a global API throttle to prevent bursting 100 requests to ComfyUI/Cloudflare simultaneously.
const globalFetchSemaphore = new Semaphore(10); 

/**
 * A robust fetch wrapper that features:
 * 1. Global concurrency limiting (Traffic Shaping)
 * 2. Exponential backoff with jitter on 429 and 50x errors
 * 3. Graceful handling of network timeouts
 *
 * @param {string} url - The URL to fetch
 * @param {object} options - Standard fetch options
 * @param {object} retryConfig - Configuration for retry behavior
 * @returns {Promise<Response>} - Resolves to the fetch Response object
 */
export async function fetchWithRetry(url, options = {}, retryConfig = {}) {
  const maxRetries = retryConfig.maxRetries ?? 3;
  const baseDelayMs = retryConfig.baseDelayMs ?? 1500; // 1.5s base delay

  let attempt = 0;

  while (attempt <= maxRetries) {
    await globalFetchSemaphore.acquire();
    let response;
    let fetchError;
    try {
      response = await fetch(url, options);
    } catch (err) {
      fetchError = err; // Network error or AbortError
    } finally {
      globalFetchSemaphore.release();
    }

    if (fetchError) {
      // If it's a timeout (AbortError), we might want to retry
      if (fetchError.name === 'AbortError' || fetchError.name === 'TimeoutError' || fetchError.message.includes('fetch failed')) {
         if (attempt >= maxRetries) throw fetchError;
      } else {
         // Other fatal errors (e.g., DNS error, Invalid URL), throw immediately
         throw fetchError;
      }
    } else {
      // HTTP response received
      const status = response.status;
      
      // If success or a client error (except 429), return the response and let the caller handle it.
      if (status >= 200 && status < 400) return response;
      if (status >= 400 && status < 500 && status !== 429) return response;

      // If it's 429 (Too Many Requests) or 50x (Server Errors like 502 Bad Gateway)
      if (status === 429 || status >= 500) {
        if (attempt >= maxRetries) {
           return response; // Exhausted retries, let caller handle the failure
        }
      }
    }

    // Wait before retrying (Exponential backoff + Jitter)
    attempt++;
    const delay = baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 500); // 0-500ms random jitter to scatter thundering herd
    const finalDelay = delay + jitter;
    
    let targetDomain = url;
    try { targetDomain = new URL(url).hostname; } catch(e) {}
    console.warn(`[Fetch Retry] Attempt ${attempt}/${maxRetries} failed for ${targetDomain}. Retrying in ${finalDelay}ms...`);
    await sleep(finalDelay);
  }
}

import DigestClient from "digest-fetch";
import fetch from "node-fetch";

const BASE_URL = "https://cloud.mongodb.com/api/atlas/v2";

// Atlas Admin API uses versioned media types. Pinning a specific date keeps
// response shapes stable even if MongoDB rolls out new API versions later.
const ACCEPT_HEADER = "application/vnd.atlas.2024-08-05+json";

export class AtlasClient {
  /**
   * @param {string} publicKey  Atlas API public key (acts as username)
   * @param {string} privateKey Atlas API private key (acts as password)
   */
  constructor(publicKey, privateKey) {
    if (!publicKey || !privateKey) {
      throw new Error(
        "Missing ATLAS_PUBLIC_KEY / ATLAS_PRIVATE_KEY. Copy .env.example to .env and fill them in."
      );
    }
    // Atlas's Admin API uses HTTP Digest Auth with the MD5 algorithm.
    this.digest = new DigestClient(publicKey, privateKey, { algorithm: "MD5" });
  }

  /**
   * Perform a GET request against the Atlas Admin API.
   * @param {string} path e.g. "/groups/{groupId}/clusters"
   * @param {Record<string, any>} query query string params (arrays are repeated keys)
   */
  async get(path, query = {}) {
    const url = new URL(BASE_URL + path);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, v);
      } else {
        url.searchParams.append(key, value);
      }
    }

    // digest-fetch needs a real fetch implementation passed in (or global fetch).
    const res = await this.digest.fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: ACCEPT_HEADER,
        "Content-Type": "application/json",
      },
    });

    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }

    if (!res.ok) {
      const detail =
        body && typeof body === "object"
          ? `${body.errorCode ?? res.status}: ${body.detail ?? body.reason ?? text}`
          : `${res.status} ${res.statusText}: ${text}`;
      throw new Error(`Atlas API request failed [${path}] -> ${detail}`);
    }

    return body;
  }
}

// Make digest-fetch use node-fetch under the hood on Node versions where a
// global fetch isn't already patched (digest-fetch v3 relies on global fetch
// or an injected one via its constructor options in some versions; we patch
// globalThis.fetch defensively for older Node runtimes).
if (typeof globalThis.fetch !== "function") {
  globalThis.fetch = fetch;
}

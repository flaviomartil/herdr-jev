import { classifyWith } from "./common.js";
import type { Classifier } from "./types.js";

export const classifyCodex: Classifier = (result) =>
  classifyWith(
    {
      quota: /you(?:'|’)ve hit your usage limit|usage limit (?:reached|exceeded)|insufficient_quota|exceeded your current quota/i,
      auth: /not logged in|please (?:log ?in|sign in)|invalid api key|unauthori[sz]ed|\b401\b|token (?:expired|revoked)|refresh token/i,
      transient: /\b429\b|rate.?limit|too many requests|\b50[0234]\b|overloaded|service unavailable|stream disconnected|ECONNRESET|ECONNREFUSED|ETIMEDOUT|connection (?:reset|refused|error)|temporarily/i,
      request: /invalid_request_error|\b400\b|bad request|context_length_exceeded|unknown model|model .* does not exist/i,
    },
    result,
  );

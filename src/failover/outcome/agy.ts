import { classifyWith } from "./common.js";
import type { Classifier } from "./types.js";

export const AGY_AUTH_EARLY = /authentication (?:required|failed)|accounts\.google\.com\/o\/oauth|oauth2?\/auth|sign in (?:with|to) |please (?:log ?in|sign in)|not (?:logged|signed) in/i;

export const AGY_AUTH = /authentication (?:required|failed)|authenticat\w* (?:failed )?or timed out|accounts\.google\.com|oauth|not (?:logged|signed) in|please (?:log ?in|sign in)|sign in (?:with|to)|UNAUTHENTICATED|PERMISSION_DENIED|invalid (?:api )?(?:key|credentials)|\b40[13]\b/i;

export const classifyAgy: Classifier = (result) =>
  classifyWith(
    {
      quota: /RESOURCE_EXHAUSTED.*quota|quota (?:exceeded|exhausted|will reset)|exhausted your (?:daily )?(?:quota|capacity)|daily limit/i,
      auth: AGY_AUTH,
      transient: /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|\b50[0234]\b|UNAVAILABLE|DEADLINE_EXCEEDED|overloaded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|connection (?:reset|refused|error)|temporarily/i,
      request: /INVALID_ARGUMENT|\b400\b|bad request|model .* not found/i,
    },
    result,
  );

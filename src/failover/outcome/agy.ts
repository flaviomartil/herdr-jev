import { classifyWith } from "./common.js";
import type { Classifier } from "./types.js";

export const classifyAgy: Classifier = (result) =>
  classifyWith(
    {
      quota: /RESOURCE_EXHAUSTED.*quota|quota (?:exceeded|exhausted|will reset)|exhausted your (?:daily )?(?:quota|capacity)|daily limit/i,
      auth: /UNAUTHENTICATED|PERMISSION_DENIED|not (?:logged|signed) in|please (?:log ?in|sign in)|invalid (?:api )?(?:key|credentials)|\b401\b|\b403\b/i,
      transient: /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|\b50[0234]\b|UNAVAILABLE|DEADLINE_EXCEEDED|overloaded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|connection (?:reset|refused|error)|temporarily/i,
      request: /INVALID_ARGUMENT|\b400\b|bad request|model .* not found/i,
    },
    result,
  );

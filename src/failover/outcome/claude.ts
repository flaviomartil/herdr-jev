import { classifyWith, parseReset } from "./common.js";
import type { Classifier } from "./types.js";

function claudeReset(output: string, now: number): number | undefined {
  const epoch = output.match(/usage limit reached\|(\d{10,13})/i);
  if (epoch) {
    const raw = Number(epoch[1]);
    const at = raw < 1e12 ? raw * 1000 : raw;
    return at > now ? at : undefined;
  }
  return parseReset(output, now);
}

export const classifyClaude: Classifier = (result) =>
  classifyWith(
    {
      quota: /usage limit reached|you(?:'|’)ve hit your (?:\w+ )?limit|hit your limit|limit reached.*resets?|credit balance is too low/i,
      auth: /invalid api key|please run \/login|not logged in|authentication_error|OAuth token (?:has )?expired|\b401\b/i,
      transient: /\b429\b|rate_limit_error|\b529\b|\b50[0234]\b|overloaded_error|overloaded|API Error: (?:Request rejected|Connection|Unable)|ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection (?:reset|refused|error)|temporarily/i,
      request: /invalid_request_error|\b400\b|prompt is too long|model: .*not found/i,
      reset: claudeReset,
    },
    result,
  );

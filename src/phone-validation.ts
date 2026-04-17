/**
 * Phone number validation using libphonenumber-js.
 *
 * Validates and normalises phone numbers to E.164 format before any call is
 * placed. This prevents malformed numbers from reaching Twilio and provides
 * clear error messages to callers.
 */

import { isValidPhoneNumber, parsePhoneNumber } from "libphonenumber-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PhoneValidationResult =
  | { valid: true; e164: string }
  | { valid: false; error: string };

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Validate a raw phone number string and return its E.164 representation.
 *
 * Accepts any format that libphonenumber-js can parse (E.164, national,
 * international). Returns an error result when the number is unparseable or
 * invalid for its country.
 */
export function validatePhoneNumber(raw: string): PhoneValidationResult {
  const trimmed = raw.trim();

  if (!trimmed) {
    return { valid: false, error: "Phone number must not be empty." };
  }

  try {
    if (!isValidPhoneNumber(trimmed)) {
      return {
        valid: false,
        error: `Invalid phone number: "${trimmed}". Use E.164 format (e.g. +15551234567).`,
      };
    }

    const parsed = parsePhoneNumber(trimmed);
    return { valid: true, e164: parsed.format("E.164") };
  } catch {
    return {
      valid: false,
      error: `Could not parse phone number: "${trimmed}". Use E.164 format (e.g. +15551234567).`,
    };
  }
}

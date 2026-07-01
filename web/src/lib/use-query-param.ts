"use client";

import { useEffect, useState } from "react";

interface QueryParamOptions {
  // Optional whitelist regex. Values that don't match are coerced to "".
  // Defaults to a permissive allowlist on URL-safe ID characters and a
  // generous length cap so callers don't have to think about validation
  // for the common "highlight by ID" use cases.
  pattern?: RegExp;
  maxLength?: number;
}

const DEFAULT_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_MAX_LENGTH = 128;

export function useQueryParam(name: string, options: QueryParamOptions = {}) {
  const [value, setValue] = useState("");
  const pattern = options.pattern ?? DEFAULT_PATTERN;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

  useEffect(() => {
    function readValue() {
      const raw = new URLSearchParams(window.location.search).get(name) || "";
      // Cap length first so a giant attacker-supplied value can't even reach
      // the regex check.
      const trimmed = raw.slice(0, maxLength);
      setValue(pattern.test(trimmed) ? trimmed : "");
    }

    readValue();
    window.addEventListener("popstate", readValue);
    return () => window.removeEventListener("popstate", readValue);
  }, [name, maxLength, pattern]);

  return value;
}

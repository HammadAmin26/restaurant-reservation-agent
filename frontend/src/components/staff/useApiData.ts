"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, getApiErrorMessage } from "@/lib/api";

type ApiData<T> = {
  data: T | null;
  // A message safe to show, or null
  error: string | null;
  // The failed response's HTTP status (0 when the API wasn't reached), or null
  errorStatus: number | null;
  isLoading: boolean;
  retry: () => void;
};

type Loaded<T> = { key: string; data: T | null; error: string | null; errorStatus: number | null };

// Load data from the API, again whenever `key` changes. A response that
// arrives after the key changed is ignored, so a slow answer for an older
// date never replaces a newer one.
export function useApiData<T>(load: () => Promise<T>, key: string): ApiData<T> {
  const [state, setState] = useState<Loaded<T> | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let ignore = false;
    load()
      .then((data) => {
        if (!ignore) setState({ key, data, error: null, errorStatus: null });
      })
      .catch((error: unknown) => {
        if (ignore) return;
        const errorStatus = error instanceof ApiError ? error.status : null;
        setState({ key, data: null, error: getApiErrorMessage(error), errorStatus });
      });
    return () => {
      ignore = true;
    };
    // load is read through key: it changes exactly when key does
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const retry = useCallback(() => {
    setState(null);
    setAttempt((value) => value + 1);
  }, []);

  // Until the answer for this key arrives, it's loading
  const current = state?.key === key ? state : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    errorStatus: current?.errorStatus ?? null,
    isLoading: current === null,
    retry,
  };
}

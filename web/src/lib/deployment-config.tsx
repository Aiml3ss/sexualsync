"use client";

import { createContext, useContext } from "react";

export type DeploymentConfigState = {
  ready: boolean;
  selfHost: boolean;
  googleAuthEnabled: boolean;
  emailAuthEnabled: boolean;
  localPasswordAuthEnabled: boolean;
};

export const DEFAULT_DEPLOYMENT_CONFIG: DeploymentConfigState = {
  ready: false,
  selfHost: false,
  googleAuthEnabled: false,
  emailAuthEnabled: false,
  localPasswordAuthEnabled: false,
};

export const DeploymentConfigContext = createContext<DeploymentConfigState>(DEFAULT_DEPLOYMENT_CONFIG);

export function useDeploymentConfig(): DeploymentConfigState {
  return useContext(DeploymentConfigContext);
}

// The config values are deploy-time constants (which auth methods exist, which
// runtime this is) — but the gate used to hold the WHOLE app on a blank div
// until /api/config answered, putting one serial round-trip in front of every
// cold start. Cache the last-known config and render optimistically from it;
// the background fetch corrects it within the session if a deploy changed it.
// No PII: runtime flags only.
const DEPLOYMENT_CONFIG_CACHE_KEY = "ss-deployment-config-v1";

export function readCachedDeploymentConfig(): DeploymentConfigState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DEPLOYMENT_CONFIG_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      ready: true,
      selfHost: parsed.selfHost === true,
      googleAuthEnabled: parsed.googleAuthEnabled === true,
      emailAuthEnabled: parsed.emailAuthEnabled === true,
      localPasswordAuthEnabled: parsed.localPasswordAuthEnabled === true,
    };
  } catch {
    return null;
  }
}

function writeCachedDeploymentConfig(config: DeploymentConfigState) {
  if (typeof window === "undefined") return;
  try {
    const { ready: _ready, ...flags } = config;
    window.localStorage.setItem(DEPLOYMENT_CONFIG_CACHE_KEY, JSON.stringify(flags));
  } catch { /* private mode / quota — cache is best-effort */ }
}

export async function loadDeploymentConfig(signal?: AbortSignal): Promise<DeploymentConfigState> {
  const response = await fetch("/api/config", {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) throw new Error("config unavailable");
  const body = await response.json();
  const config: DeploymentConfigState = {
    ready: true,
    selfHost: body?.selfHost === true || body?.runtimeTarget === "node",
    googleAuthEnabled: body?.googleAuthEnabled === true,
    emailAuthEnabled: body?.emailAuthEnabled === true,
    localPasswordAuthEnabled: body?.localPasswordAuthEnabled === true,
  };
  writeCachedDeploymentConfig(config);
  return config;
}

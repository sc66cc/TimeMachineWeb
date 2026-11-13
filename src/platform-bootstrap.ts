import {
  TimeMachineFeature,
  TimeMachinePlatformRuntime,
  type CapabilitySnapshot,
} from "@timemachine/platform-runtime";

let activeRuntime: TimeMachinePlatformRuntime | undefined;
let bootstrapPromise: Promise<CapabilitySnapshot | undefined> | undefined;

export const TIME_MACHINE_ACCESS_TOKEN_KEY =
  "timemachine:web:phase1b-access-token";

export const LOCAL_ACCEPTANCE_VERIFICATION_CODE =
  import.meta.env.DEV && !import.meta.env.VITE_TIMEMACHINE_SERVER_URL
    ? "123456"
    : undefined;

export function getTimeMachineServerUrl(): string | undefined {
  const configuredUrl = import.meta.env.VITE_TIMEMACHINE_SERVER_URL?.trim();
  if (configuredUrl) {
    return configuredUrl;
  }
  return import.meta.env.DEV ? "http://127.0.0.1:5130" : undefined;
}

export function isTimeMachineServerConfigured(): boolean {
  return Boolean(getTimeMachineServerUrl());
}

export function getTimeMachinePlatformRuntime():
  | TimeMachinePlatformRuntime
  | undefined {
  return activeRuntime;
}

export async function bootstrapTimeMachinePlatform(): Promise<
  CapabilitySnapshot | undefined
> {
  bootstrapPromise ??= bootstrapPlatform();
  return bootstrapPromise;
}

async function bootstrapPlatform(): Promise<CapabilitySnapshot | undefined> {
  const baseUrl = getTimeMachineServerUrl();
  if (!baseUrl) {
    return undefined;
  }

  activeRuntime = new TimeMachinePlatformRuntime({
    baseUrl,
    clientVersion:
      import.meta.env.VITE_TIMEMACHINE_CLIENT_VERSION ?? "0.1.0-web",
    getAccessToken: () =>
      window.sessionStorage.getItem(TIME_MACHINE_ACCESS_TOKEN_KEY),
    getRequestToken: (path) => window.sessionStorage.getItem(path),
    onAuthEvent: (event) => {
      window.dispatchEvent(
        new CustomEvent("timemachine:auth", { detail: event }),
      );
    },
  });

  const snapshot = await activeRuntime.loadCapabilities();
  document.documentElement.dataset.timeMachineContract =
    snapshot.contractVersion;
  document.documentElement.dataset.projectRevisionV2 = String(
    activeRuntime.isEnabled(TimeMachineFeature.ProjectRevisionV2),
  );
  return snapshot;
}

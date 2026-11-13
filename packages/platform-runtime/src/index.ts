import {
  RPCInvoker,
  type RPCClientOptions,
} from "@timemachine/api-client";
import {
  TimeMachineClientType,
  TimeMachineFeature,
  TimeMachinePlatformInvoker,
  TimeMachineTelemetryVO,
  ViEnum32,
} from "@timemachine/generated-api";

export interface FeatureState {
  enabled: boolean;
  readOnly: boolean;
  reason: string;
}

export interface CapabilitySnapshot {
  clientVersion: string;
  contractVersion: string;
  features: ReadonlyMap<TimeMachineFeature, FeatureState>;
  serverTime: Date;
}

export interface TimeMachinePlatformOptions
  extends Omit<RPCClientOptions, "baseUrl"> {
  baseUrl: string;
  clientVersion: string;
}

function enumValue(value: number | { Value: number }): number {
  return typeof value === "number" ? value : value.Value;
}

function requireData<T>(result: {
  Code: number;
  Data?: T;
  Message: string;
}): T {
  if (result.Code !== 200 || result.Data === undefined) {
    throw new Error(
      `TimeMachine platform RPC failed (${result.Code}): ${result.Message}`,
    );
  }
  return result.Data;
}

export class TimeMachinePlatformRuntime {
  readonly clientVersion: string;
  private snapshot: CapabilitySnapshot | undefined;

  constructor(options: TimeMachinePlatformOptions) {
    const { clientVersion, ...rpcOptions } = options;
    this.clientVersion = clientVersion;
    RPCInvoker.Configure(rpcOptions);
  }

  get capabilities(): CapabilitySnapshot | undefined {
    return this.snapshot;
  }

  isEnabled(feature: TimeMachineFeature): boolean {
    return this.snapshot?.features.get(feature)?.enabled ?? false;
  }

  isReadOnly(feature: TimeMachineFeature): boolean {
    return this.snapshot?.features.get(feature)?.readOnly ?? true;
  }

  async loadCapabilities(): Promise<CapabilitySnapshot> {
    const result = await TimeMachinePlatformInvoker.GetCapabilities(
      new ViEnum32<TimeMachineClientType>(TimeMachineClientType.Web),
      this.clientVersion,
    );
    const data = requireData(result);
    const features = new Map<TimeMachineFeature, FeatureState>();
    for (const flag of data.FeatureList) {
      const feature = enumValue(
        flag.Feature as unknown as number | { Value: number },
      ) as TimeMachineFeature;
      features.set(feature, {
        enabled: flag.Enabled,
        readOnly: flag.ReadOnly,
        reason: flag.Reason,
      });
    }

    this.snapshot = {
      clientVersion: data.ClientVersion,
      contractVersion: data.ContractVersion,
      features,
      serverTime: new Date(data.ServerTime),
    };
    return this.snapshot;
  }

  async recordTelemetry(input: {
    correlationId?: string;
    dimensions?: Readonly<Record<string, string>>;
    durationMs: number;
    eventName: string;
    feature: TimeMachineFeature;
    itemCount?: number;
    success: boolean;
  }): Promise<void> {
    const property = new TimeMachineTelemetryVO();
    property.Client.Value = TimeMachineClientType.Web;
    property.ClientVersion = this.clientVersion;
    property.Feature.Value = input.feature;
    property.EventName = input.eventName;
    property.DurationMs = input.durationMs;
    property.ItemCount = input.itemCount ?? 0;
    property.Success = input.success;
    property.CorrelationID = input.correlationId ?? "";
    for (const [key, value] of Object.entries(input.dimensions ?? {})) {
      property.DimensionList.set(key, value);
    }
    requireVoid(await TimeMachinePlatformInvoker.RecordTelemetry(property));
  }
}

function requireVoid(result: { Code: number; Message: string }): void {
  if (result.Code !== 200) {
    throw new Error(
      `TimeMachine telemetry RPC failed (${result.Code}): ${result.Message}`,
    );
  }
}

export { TimeMachineClientType, TimeMachineFeature };

export { CredentialConfigError, ProviderError } from "./contract.ts";
export type {
  ActivityLease,
  ComputerProvider,
  ComputerRef,
  ComputerState,
  ComputerStatus,
  ExecOptions,
  ExecResult,
  FileEntry,
  ProvisionOptions,
  ProviderErrorCode,
  Screenshot,
} from "./contract.ts";

export { InstaboxClient, providerErrorFrom, DEFAULT_BASE_URL } from "./instabox/client.ts";
export type { InstaboxClientOptions, InstaboxMachine, InstaboxOperation } from "./instabox/client.ts";
export { InstaboxProvider, mapStatus } from "./instabox/provider.ts";
export type { InstaboxProviderOptions } from "./instabox/provider.ts";

export { FakeComputerProvider } from "./fake.ts";
export type { FakeFailure, FakeOperation, FakeProviderOptions } from "./fake.ts";

export { ALLOCATOR_DEFAULTS, ComputerAllocator, describeFailures } from "./allocator/allocator.ts";
export type { AllocatorConfig, AllocatorOptions, ReconcileOptions } from "./allocator/allocator.ts";
export { DrizzleComputerStore } from "./allocator/drizzle-store.ts";
export { MemoryComputerStore } from "./allocator/memory-store.ts";
export { rowStatusFrom, toRef } from "./allocator/types.ts";
export type {
  AccountRecord,
  AllocateResult,
  BindingRecord,
  BindingState,
  ComputerRecord,
  ComputerRowStatus,
  ComputerStore,
  CreateComputerInput,
  EnsureReadyOptions,
  EnsureReadyResult,
  LeaseRecord,
  ProviderFactory,
  ReconcileSummary,
  SweepSummary,
} from "./allocator/types.ts";

export { createProviderFactory } from "./registry.ts";
export type { ProviderRegistryOptions } from "./registry.ts";

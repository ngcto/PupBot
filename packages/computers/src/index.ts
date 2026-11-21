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

export {
  AGENT37_API_URL,
  AGENT37_DEFAULT_PORT,
  AGENT37_SANDBOX_URL,
  AGENT37_STATES,
  AGENT37_TRANSITIONAL,
  Agent37Client,
  classifyAgent37,
  providerErrorFrom as agent37ErrorFrom,
} from "./agent37/client.ts";
export type {
  Agent37ClientOptions,
  Agent37CreateBody,
  Agent37ExecResult,
  Agent37Instance,
  Agent37RequestOptions,
  Agent37State,
} from "./agent37/client.ts";
export { AGENT37_UNSUPPORTED, Agent37Provider } from "./agent37/provider.ts";
export type { Agent37ProviderOptions, Agent37Unsupported } from "./agent37/provider.ts";

export { FakeComputerProvider } from "./fake.ts";
export type { FakeFailure, FakeOperation, FakeProviderOptions } from "./fake.ts";

export {
  ALLOCATOR_DEFAULTS,
  ComputerAllocator,
  accountClass,
  describeFailures,
  describeMissingCapabilities,
  eligibleAccounts,
} from "./allocator/allocator.ts";
export type { AllocatorConfig, AllocatorOptions, ReconcileOptions } from "./allocator/allocator.ts";
export { DrizzleComputerStore } from "./allocator/drizzle-store.ts";
export { MemoryComputerStore } from "./allocator/memory-store.ts";
export { rowStatusFrom, toRef } from "./allocator/types.ts";
export { NO_POOL, classifyFailure } from "./allocator/failures.ts";
export type { ComputerFailure, ComputerFailureCode, PoolAvailability } from "./allocator/failures.ts";
export type {
  AccountRecord,
  AllocateResult,
  AllocateOptions,
  BindingRecord,
  BindingState,
  ComputerRecord,
  ComputerRowStatus,
  ComputerStore,
  CreateComputerInput,
  EnsureReadyOptions,
  EnsureReadyResult,
  LeaseRecord,
  OrphanReason,
  OrphanRecord,
  ProviderFactory,
  ReconcileSummary,
  RequiredCapability,
  SweepSummary,
} from "./allocator/types.ts";

export { DEFAULT_REQUIREMENTS } from "./allocator/types.ts";
export { createComputerRuntime, createRunComputer, runComputerWithLease } from "./run-computer.ts";
export type { RunComputerSignature } from "./run-computer.ts";
export type { LeaseResult, MachineExecSummary, MachineHandle, RunObstacle } from "./run-computer.ts";
export { createProviderFactory } from "./registry.ts";
export type { ProviderRegistryOptions } from "./registry.ts";

export { MANAGED_PROVIDERS, ensureManagedComputerAccounts, managedProviderSpecs } from "./accounts.ts";
export type {
  EnsureManagedAccountsResult,
  ManagedAccountEnv,
  ManagedProvider,
  ManagedProviderSpec,
} from "./accounts.ts";

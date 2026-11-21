export { VaultError, describeVaultError } from "./errors.ts";
export type { VaultErrorCode } from "./errors.ts";
export {
  VAULT_KINDS,
  VAULT_KIND_LIST,
  fieldNamesOf,
  fieldOf,
  fieldsOf,
  groupedValue,
  hintFor,
  isVaultKind,
  requiredFieldNames,
} from "./kinds.ts";
export type { VaultField, VaultKind, VaultKindDefinition, SecretFieldInput } from "./kinds.ts";
export { VaultService, hostOf, normaliseDomain, vaultCount } from "./service.ts";
export type { VaultItemInput, VaultItemView } from "./service.ts";
export { domainMatches, fillFromVault } from "./fill.ts";
export { EPHEMERAL_PREFIX, SecretRequestService, oneShotSecrets, readOneShot, setOneShotSecrets } from "./requests.ts";
export { createEphemeralSecrets, ephemeralIdFor, isEphemeralId } from "./ephemeral.ts";
export type { EphemeralEntry, EphemeralSecrets } from "./ephemeral.ts";
export type { SecretRequestView, SubmitInput } from "./requests.ts";
export { vaultTools } from "./tools-run.ts";
export type { VaultToolsOptions } from "./tools-run.ts";
export type { FillEffect, FillRequest, FillResult, FillTarget, VaultFillOutcome, VaultFillSink } from "./fill.ts";
export { normaliseTotpSecret, totpCode } from "./totp.ts";
export type { TotpCode } from "./totp.ts";
export { FILLABLE_FIELDS, VAULT_FILL, VAULT_FIND, VAULT_REQUEST, VAULT_TOTP, vaultToolSchemas } from "./tools.ts";

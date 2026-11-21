/**
 * The three vault kinds and their fields, defined once.
 *
 * Everything that touches a vault value reads this table: the add/edit form, the
 * ask-the-user card, validation on submit, and the fill tool. A field marked
 * `secret` is encrypted at rest and never rendered; a field marked plain is
 * ordinary profile data the list may print.
 *
 * `optional: true` means the form may leave it blank. Nothing is validated as
 * "probably a real card number" beyond length and digits — we are not a payment
 * processor and refusing an unusual-but-valid value would be worse than storing it.
 */

export type VaultKind = "login" | "card" | "contact";

export type SecretFieldInput = "text" | "password" | "email" | "tel" | "number";

export interface VaultField {
  /** Stored key. Also the JSON key in `meta` or `secrets`. */
  name: string;
  label: string;
  /** Encrypted at rest, masked in every UI surface, never in a model's context. */
  secret: boolean;
  input: SecretFieldInput;
  optional?: boolean;
  /** Longest accepted value, in characters. */
  maxLength: number;
  /** Shown under the input. */
  hint?: string;
  /**
   * Per-keystroke grouping for card fields, applied as the person types. Purely
   * presentation: the stored value is digits only.
   */
  group?: number[];
  /** What the groups are joined with: a space for a card number, "/" for an expiry. */
  separator?: string;
}

export interface VaultKindDefinition {
  kind: VaultKind;
  /** What the kind is called in the UI. */
  label: string;
  /** One line under the heading of the add form. */
  summary: string;
  fields: VaultField[];
  /** The field whose masked tail becomes the item's `hint`. */
  hintField: string | null;
}

const USERNAME: VaultField = {
  name: "username",
  label: "Username or email",
  secret: false,
  input: "text",
  maxLength: 320,
};

export const VAULT_KINDS: Record<VaultKind, VaultKindDefinition> = {
  login: {
    kind: "login",
    label: "Login",
    summary: "A site's username and password, plus a 2FA secret if it has one.",
    hintField: "password",
    fields: [
      USERNAME,
      {
        name: "password",
        label: "Password",
        secret: true,
        input: "password",
        maxLength: 1024,
      },
      {
        name: "totp",
        label: "2FA secret key",
        secret: true,
        input: "password",
        optional: true,
        maxLength: 512,
        hint: "The key the site shows when you set up an authenticator app. Codes are generated at sign-in; the code itself is never stored.",
      },
    ],
  },
  card: {
    kind: "card",
    label: "Payment card",
    summary: "A card the bot may use to pay on a site you trust.",
    hintField: "number",
    fields: [
      {
        name: "holder",
        label: "Name on card",
        secret: false,
        input: "text",
        maxLength: 200,
      },
      {
        name: "number",
        label: "Card number",
        secret: true,
        input: "number",
        maxLength: 32,
        group: [4, 4, 4, 4, 3],
      },
      {
        name: "expiry",
        label: "Expiry",
        // Encrypted at rest like the rest of the card, but not masked in the input:
        // a hidden MM/YY is friction with nothing to protect, because it is useless
        // without the number beside it.
        secret: true,
        input: "text",
        maxLength: 7,
        hint: "MM/YY",
        group: [2, 2],
        separator: "/",
      },
      {
        name: "cvc",
        label: "Security code",
        secret: true,
        input: "password",
        maxLength: 8,
      },
    ],
  },
  contact: {
    kind: "contact",
    label: "Contact info",
    summary: "Your name, email, phone and address, for filling in forms.",
    hintField: null,
    fields: [
      { name: "name", label: "Full name", secret: false, input: "text", maxLength: 200 },
      { name: "email", label: "Email", secret: false, input: "email", maxLength: 320 },
      {
        name: "phone",
        label: "Phone",
        secret: false,
        input: "tel",
        optional: true,
        maxLength: 40,
      },
      {
        name: "address1",
        label: "Address",
        secret: false,
        input: "text",
        optional: true,
        maxLength: 300,
      },
      {
        name: "address2",
        label: "Address line 2",
        secret: false,
        input: "text",
        optional: true,
        maxLength: 300,
      },
      { name: "city", label: "City", secret: false, input: "text", optional: true, maxLength: 120 },
      { name: "region", label: "State or region", secret: false, input: "text", optional: true, maxLength: 120 },
      { name: "postcode", label: "Postcode", secret: false, input: "text", optional: true, maxLength: 40 },
      { name: "country", label: "Country", secret: false, input: "text", optional: true, maxLength: 120 },
    ],
  },
};

export const VAULT_KIND_LIST: VaultKindDefinition[] = [VAULT_KINDS.login, VAULT_KINDS.card, VAULT_KINDS.contact];

export function isVaultKind(value: unknown): value is VaultKind {
  return value === "login" || value === "card" || value === "contact";
}

export function fieldsOf(kind: VaultKind): VaultField[] {
  return VAULT_KINDS[kind].fields;
}

export function fieldNamesOf(kind: VaultKind, options: { secretOnly?: boolean } = {}): string[] {
  return fieldsOf(kind)
    .filter((field) => (options.secretOnly ? field.secret : true))
    .map((field) => field.name);
}

export function fieldOf(kind: VaultKind, name: string): VaultField | null {
  return fieldsOf(kind).find((field) => field.name === name) ?? null;
}

/** The optional fields of a kind, which a request card may leave out. */
export function requiredFieldNames(kind: VaultKind): string[] {
  return fieldsOf(kind)
    .filter((field) => !field.optional)
    .map((field) => field.name);
}

/**
 * Digits only, for the fields that are digits only. Spaces and dashes are how
 * people type a card number; storing them would make a later fill site-specific.
 */
export function normaliseCardValue(field: VaultField, value: string): string {
  return field.input === "number" || field.group ? value.replace(/[^0-9/]/g, "") : value;
}

/**
 * The digit groups of a partly-typed value, joined by the field's own separator.
 *
 * Takes the two presentation bits rather than a whole definition, so a form that
 * holds only what it was sent from the API — and not a `VaultField` — can use it too.
 */
export function groupedValue(value: string, group: number[] | null, separator = " "): string {
  if (!group) return value;
  const digits = value.replace(/\D/g, "");
  const parts: string[] = [];
  let index = 0;
  for (const size of group) {
    if (index >= digits.length) break;
    parts.push(digits.slice(index, index + size));
    index += size;
  }
  if (index < digits.length) parts.push(digits.slice(index));
  return parts.join(separator);
}

/**
 * The masked tail a list shows without touching the ciphertext: the last four
 * characters of the hint field. Computed once on write, so listing a vault never
 * decrypts anything.
 */
export function hintFor(kind: VaultKind, values: Record<string, string>): string | null {
  const name = VAULT_KINDS[kind].hintField;
  if (!name) return null;
  const value = (values[name] ?? "").replace(/\s+/g, "");
  if (!value) return null;
  return value.length <= 4 ? "••••" : `•••• ${value.slice(-4)}`;
}

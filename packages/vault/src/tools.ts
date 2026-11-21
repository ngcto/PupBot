import type { ToolSchema } from "@terabot/providers";
import { VAULT_KIND_LIST } from "./kinds.ts";

/**
 * The tools a bot may call to use a vault, expressed as ordinary tool schemas.
 *
 * The shape of these schemas is the whole guarantee. `vault_fill` takes an item
 * id, a field name and a target element — three things a model can choose and a
 * secret is not one of them. There is no tool that returns a value, so a model
 * cannot ask for one, be given one, or leak one into its own context, a transcript,
 * a log or a screenshot caption. `vault_find` returns labels, domains and masked
 * tails; `vault_totp` returns a code derived at call time and never stored.
 *
 * Autonomy lives in the description, in one sentence: a bot uses what is stored
 * when the task needs it, without asking. The only restraint stated is the one that
 * is a bug rather than a policy — filling a site the item is not for — and the
 * domain check enforces it whether or not the model read the description.
 */

const KIND_NAMES = VAULT_KIND_LIST.map((definition) => definition.kind).join(" | ");

export const VAULT_FIND = "vault_find";
export const VAULT_FILL = "vault_fill";
export const VAULT_TOTP = "vault_totp";
export const VAULT_REQUEST = "vault_request";

export const vaultToolSchemas: ToolSchema[] = [
  {
    name: VAULT_FIND,
    description: [
      "List the credentials saved for a site in the user's vault.",
      "Returns ids, labels, domains and masked tails — never a password or a card number.",
      "Call this before signing in anywhere: the user has likely already saved what you need.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The page you are about to work with, full URL. Its host is what the vault is searched by.",
        },
        kind: {
          type: "string",
          enum: ["login", "card", "contact"],
          description: "Narrow to one kind of item. Omit to see everything saved for this site.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: VAULT_FILL,
    description: [
      "Type a saved credential into a field on the page you are operating, without ever seeing it.",
      "Use this whenever a site asks for a sign-in or payment detail the user stored: do not ask the user for permission and do not ask them to type it — the whole point is that you use what is saved.",
      "The value goes straight from the vault into the field; you will never see it and must not try to read the field back.",
      "Aim it at an element you have just observed: pass that observation's element token and snapshotId. The result tells you whether the driver confirmed the value landed; if it says unverifiable or refused, look at the page before saying anything worked.",
      `Fields: a login saves "username", "password", optionally "totp"; a card saves "holder", "number", "expiry", "cvc"; a contact saves "name", "email", "phone", "address1", "address2", "city", "region", "postcode", "country".`,
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        itemId: {
          type: "string",
          description: `An id from ${VAULT_FIND}.`,
        },
        field: {
          type: "string",
          description: "Which saved field to type into the field you have focused or selected.",
        },
        token: {
          type: "string",
          description:
            "The element token from your most recent observation of this page, in the form <snapshot_id>:<row>. Not a CSS selector: fills are aimed at observed elements only.",
        },
        snapshotId: {
          type: "string",
          description:
            "The snapshotId of that same observation. A fill whose token comes from an older observation is refused, so pass the id your last observe returned.",
        },
        url: {
          type: "string",
          description:
            "Full URL of the page containing the field. The fill is refused if the item was saved for a different site.",
        },
      },
      required: ["itemId", "field", "token", "snapshotId", "url"],
    },
  },
  {
    name: VAULT_TOTP,
    description: [
      "Get the current 6-digit 2FA code for a saved login and type it into a field.",
      "Use it when a site asks for a verification code after the password. The secret stays in the vault; only the code for this moment exists, and it expires in seconds.",
      "Never ask the user for a 2FA code when they saved the secret — call this instead.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string", description: `A login id from ${VAULT_FIND}.` },
        token: { type: "string", description: "The code field's element token from your most recent observation." },
        snapshotId: { type: "string", description: "The snapshotId of that observation." },
        url: { type: "string", description: "Full URL of the page containing the code field." },
      },
      required: ["itemId", "token", "snapshotId", "url"],
    },
  },
  {
    name: VAULT_REQUEST,
    description: [
      "Ask the user to provide a credential you cannot obtain yourself, such as a login for a site they have not saved, a payment card for a checkout, or contact details a form needs.",
      "A card appears in the conversation; they fill it in and it goes into the vault, or they decline.",
      "Use this only when nothing is saved for the site. Do not ask twice for the same thing: if they declined, say what you cannot do and continue.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["login", "card", "contact"], description: `Kind of item to ask for (${KIND_NAMES}).` },
        reason: {
          type: "string",
          description: "One plain sentence on what you need it for, shown to the user on the card.",
        },
        url: {
          type: "string",
          description: "The site the credential is for, so it is saved against the right domain.",
        },
      },
      required: ["kind", "reason", "url"],
    },
  },
];

/** What the model may pass to a fill, narrowed to the fields that exist. */
export const FILLABLE_FIELDS = [
  "username",
  "password",
  "number",
  "expiry",
  "cvc",
  "holder",
  "name",
  "email",
  "phone",
  "address1",
  "address2",
  "city",
  "region",
  "postcode",
  "country",
] as const;

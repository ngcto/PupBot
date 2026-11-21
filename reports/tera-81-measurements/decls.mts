import { TOOLS } from "./schemas.ts";
import { TOOL_INDEX } from "./tool-index.ts";

/** pi's renderDeclarations shape: an interface per tool, then a `declare const tools`. */
function renderJsonSchema(schema: any, indent = 2): string {
  const pad = " ".repeat(indent);
  if (schema.type === "object") {
    const props = schema.properties ?? {};
    const required: string[] = schema.required ?? [];
    const lines = Object.entries(props).map(([key, value]: [string, any]) => {
      const optional = required.includes(key) ? "" : "?";
      const doc = value.description ? `${pad}  /** ${value.description} */\n` : "";
      return `${doc}${pad}  ${key}${optional}: ${renderJsonSchema(value, indent + 2)};`;
    });
    return `{\n${lines.join("\n")}\n${pad}}`;
  }
  if (schema.type === "array") return `${renderJsonSchema(schema.items ?? {}, indent)}[]`;
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  return "string";
}

const camel = (name: string) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const entryFor = (jsName: string) => TOOL_INDEX.find((e) => e.name === camel(jsName));

const decls = TOOLS.map((tool) => {
  const entry = entryFor(tool.name);
  const doc = [
    entry?.description ?? tool.description,
    ...(entry?.when?.length ? [`When: ${entry.when.join("; ")}.`] : []),
    ...(entry?.resultNote ? [`Result: ${entry.resultNote}`] : []),
    `Cost: ${entry?.cost ?? "cheap"}.`,
  ].join("\n");
  return `  /**\n${doc.split("\n").map((l) => `   * ${l}`).join("\n")}\n   */\n  ${camel(tool.name).replace(/^./, (c) => c.toLowerCase())}(args: ${renderJsonSchema(tool.parameters)}): Promise<unknown>;`;
}).join("\n");

const out = `declare const tools: {\n${decls}\n};`;
console.log(JSON.stringify(out));

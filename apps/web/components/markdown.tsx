"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkSquare02Icon, Copy01Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { cn } from "@terabot/ui";

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      className="flex size-6 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-raised-2 hover:text-ink"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      <HugeiconsIcon icon={copied ? CheckmarkSquare02Icon : Copy01Icon} size={14} strokeWidth={1.8} />
    </button>
  );
}

/**
 * Deliberate non-defaults from the parity spec: inline code has no chip, tables
 * sit on their own bordered card with a copy control, and headings are only one
 * step above body text.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("text-body text-ink", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          p: ({ children }) => <p className="my-0 whitespace-pre-wrap [&+*]:mt-3">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="my-3 list-none space-y-1 pl-0">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => (
            <li className="relative pl-4 leading-[22px] before:absolute before:left-0 before:top-[9px] before:size-1 before:rounded-pill before:bg-ink-secondary">
              {children}
            </li>
          ),
          h1: ({ children }) => <h1 className="mb-3 mt-4 text-md font-bold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-3 mt-4 text-md font-bold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-3 text-body font-bold">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-strong pl-3 text-ink-secondary">{children}</blockquote>
          ),
          hr: () => <hr className="my-4 border-hairline" />,
          code: ({ className: codeClass, children, ...props }) => {
            const isBlock = Boolean(codeClass?.includes("language-"));
            if (!isBlock) {
              return (
                <code className="font-mono text-body text-ink" {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className={cn("font-mono text-[12.5px] leading-[20px]", codeClass)} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => {
            const raw = extractCode(children);
            const language = raw.language;
            return (
              <div className="my-3 overflow-hidden rounded-sm border border-menu bg-[#151515]">
                <div className="flex items-center justify-between border-b border-hairline px-3 py-1.5">
                  <span className="text-xs uppercase tracking-[0.04em] text-ink-muted">{language || "code"}</span>
                  <CopyButton text={raw.text} label="Copy code" />
                </div>
                <pre className="overflow-x-auto px-3 py-2.5">{children}</pre>
              </div>
            );
          },
          table: ({ children }) => {
            const text = extractTableText(children);
            return (
              <div className="my-3 overflow-hidden rounded-sm border border-menu">
                <div className="flex justify-end border-b border-hairline bg-[#171717] px-2 py-1">
                  <CopyButton text={text} label="Copy table" />
                </div>
                <table className="w-full border-collapse text-left text-body">{children}</table>
              </div>
            );
          },
          thead: ({ children }) => <thead className="bg-[#171717]">{children}</thead>,
          th: ({ children }) => (
            <th className="border-b border-divider px-3 py-2.5 text-body font-semibold">{children}</th>
          ),
          td: ({ children }) => <td className="border-b border-divider px-3 py-2.5 align-top">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function extractCode(children: unknown): { text: string; language: string } {
  const child = Array.isArray(children) ? children[0] : children;
  if (!child || typeof child !== "object" || !("props" in child)) return { text: "", language: "" };
  const props = (child as { props?: { className?: string; children?: unknown } }).props;
  const className = props?.className ?? "";
  const language = className.match(/language-([\w-]+)/)?.[1] ?? "";
  return { text: flatten(props?.children), language };
}

function extractTableText(children: unknown): string {
  return flatten(children);
}

function flatten(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("\n");
  if (typeof node === "object" && "props" in (node as object)) {
    return flatten((node as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

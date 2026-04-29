// Org page parser/serializer. All Emacs-side logic lives in roambrain.el;
// this module is a thin TS facade.

import { EmacsClient, elispString } from "./emacs.ts";

export interface ParseValidationError {
  field: string;
  message: string;
}

export interface ParsedOrgDocument {
  /** Top-level :PROPERTIES: drawer entries (e.g. ID). */
  properties: Record<string, string>;
  /** Body excluding the `* Changelog` heading and its subtree. */
  compiled_truth: string;
  /** Body of the `* Changelog` heading (without the heading line itself). */
  timeline: string;
  /** From #+title:. */
  title: string;
  /** From #+filetags:, split on `:` separators. */
  tags: string[];
  /** Present iff opts.validate. Empty array means no errors. */
  errors?: ParseValidationError[];
}

export interface ParseOptions {
  validate?: boolean;
}

const CHANGELOG_HEADING = "Changelog";

export async function parseOrgFile(
  emacs: EmacsClient,
  path: string,
  opts: ParseOptions = {},
): Promise<ParsedOrgDocument> {
  const raw = await emacs.callJson<{
    title: string;
    tags: string[];
    properties: Record<string, string> | unknown[];
    compiled_truth: string;
    timeline: string;
  }>(`(roambrain-parse-file ${elispString(path)})`);

  const properties: Record<string, string> = Array.isArray(raw.properties)
    ? {}
    : raw.properties;

  const doc: ParsedOrgDocument = {
    properties,
    compiled_truth: raw.compiled_truth,
    timeline: raw.timeline,
    title: raw.title,
    tags: raw.tags ?? [],
  };

  if (opts.validate) doc.errors = validate(doc);
  return doc;
}

/** Render a ParsedOrgDocument back to a complete Org file string. */
export function serializeOrgDocument(doc: ParsedOrgDocument): string {
  const lines: string[] = [];

  const propEntries = Object.entries(doc.properties);
  if (propEntries.length > 0) {
    lines.push(":PROPERTIES:");
    for (const [k, v] of propEntries) lines.push(`:${k}: ${v}`);
    lines.push(":END:");
  }

  if (doc.title) lines.push(`#+title: ${doc.title}`);
  if (doc.tags && doc.tags.length > 0) {
    lines.push(`#+filetags: :${doc.tags.join(":")}:`);
  }

  if (lines.length > 0) lines.push("");

  if (doc.compiled_truth.trim().length > 0) {
    lines.push(doc.compiled_truth.trim());
  }

  if (doc.timeline.trim().length > 0) {
    if (lines[lines.length - 1] !== "") lines.push("");
    lines.push(`* ${CHANGELOG_HEADING}`);
    lines.push(doc.timeline.trim());
  }

  return lines.join("\n") + "\n";
}

function validate(doc: ParsedOrgDocument): ParseValidationError[] {
  const errs: ParseValidationError[] = [];
  if (!doc.title) errs.push({ field: "title", message: "missing #+title:" });
  if (!doc.properties.ID) {
    errs.push({ field: "properties.ID", message: "missing :ID: in top properties drawer" });
  }
  return errs;
}

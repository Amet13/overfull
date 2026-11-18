/**
 * `overfull guard --hook`: answers an agent harness's pre-tool-use hook.
 *
 * The payload is untrusted JSON from stdin. It is only read: nothing in it is
 * executed, file contents in it are never echoed back, and anything that is not
 * recognised (unknown harness, other tool, malformed JSON, no path) is allowed.
 * A guard that breaks the agent's other tools is worse than none.
 *
 * Only .bib files in an Overfull project (an overfull.yml in the file's folder or
 * above) are guarded, because the Claude Code plugin runs the hook in every project.
 * There, a write that only removes whole entries is allowed: the new text is worked
 * out from the file on disk and the tool input, and its entries must all be in the
 * old text. A write whose result cannot be worked out is denied.
 *
 * Harness formats, read from the official documentation on 2026-11-10:
 *
 * Claude Code, https://code.claude.com/docs/en/hooks (PreToolUse)
 *   stdin: { hook_event_name: "PreToolUse", tool_name, tool_input, cwd, ... }.
 *   Write: tool_input.file_path, content. Edit: tool_input.file_path, old_string,
 *   new_string, replace_all. (MultiEdit and NotebookEdit are not described on the
 *   page; they are matched by name. MultiEdit is read as file_path plus edits[] of
 *   Edit's fields; a NotebookEdit of a .bib path is denied.)
 *   deny: exit 0 with stdout
 *   { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
 *     permissionDecisionReason } }. The reason is shown to Claude.
 *   allow: exit 0 and no output ("no decision": the normal permission flow runs).
 *   Settings: .claude/settings.json, hooks.PreToolUse[{ matcher, hooks: [{ type: "command", command }] }].
 *
 * Gemini CLI, https://geminicli.com/docs/hooks/ and https://geminicli.com/docs/hooks/reference/
 *   (BeforeTool); tools: https://geminicli.com/docs/tools/file-system/
 *   stdin: { hook_event_name: "BeforeTool", tool_name, tool_input, cwd, ... }.
 *   write_file takes tool_input.file_path and content; replace takes file_path,
 *   old_string, new_string and optional expected_replacements.
 *   deny: exit 0 with stdout { decision: "deny", reason }; the reason is sent to the agent.
 *   allow: exit 0 and no output.
 *   Settings: .gemini/settings.json, hooks.BeforeTool[{ matcher, hooks: [{ name, type: "command", command, timeout }] }].
 *
 * Codex CLI, https://developers.openai.com/codex/hooks (PreToolUse)
 *   stdin: { hook_event_name: "PreToolUse", turn_id, tool_name, tool_input, cwd, ... }.
 *   File edits arrive as tool_name "apply_patch" with the patch text in
 *   tool_input.command. The patch grammar is the "official Lark grammar" in Codex's own
 *   parser (github.com/openai/codex, codex-rs/apply-patch/src/parser.rs, read 2026-11-10):
 *   files are named on "*** Add File: ", "*** Delete File: ", "*** Update File: " and
 *   "*** Move to: " lines (the parser allows whitespace around markers).
 *   deny: exit 0 with the same hookSpecificOutput shape as Claude Code.
 *   Settings: <repo>/.codex/hooks.json, hooks.PreToolUse[{ matcher, hooks: [{ type, command }] }];
 *   project hooks load only when the project's .codex/ layer is trusted.
 *
 * Not implemented, because the documentation did not confirm a usable payload:
 * Cursor (https://cursor.com/docs/agent/hooks, read 2026-11-10): preToolUse can deny a
 * "Write", but the page does not show Write's tool_input fields; afterFileEdit names the
 * file but runs after the edit and cannot block it.
 */

import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { findConfigFile } from '../config.js';
import { onlyRemovesEntries } from './entries.js';

export const HOOK_HARNESSES = ['claude', 'gemini', 'codex'] as const;
export type HookHarness = (typeof HOOK_HARNESSES)[number];

/** Payloads larger than this are not parsed (and are allowed). */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;

/** A .bib file larger than this is not read: an edit of it is denied. */
const MAX_BIB_BYTES = 32 * 1024 * 1024;

const DENY_REASON =
  'Adding or changing entries in .bib files directly is blocked in this project, because a hand-written reference can be wrong or invented. ' +
  'Add a reference with `overfull cite <doi | arXiv:id | "title">`, which looks it up and writes a verified entry. ' +
  'Removing whole entries is allowed. ' +
  'If the author wants an entry the indexes do not know, they add it by hand outside the agent.';

export type HookDecision = { allow: true } | { allow: false; reason: string };

/**
 * A file a tool call writes. `after` gives the file's new text from its current text
 * (undefined when the file does not exist), or undefined when it cannot be worked out.
 */
interface Target {
  path: unknown;
  after: (before: string | undefined) => string | undefined;
}

interface Adapter {
  /** Tool names that write a file. */
  writeTools: readonly string[];
  /** The files a tool call writes, with their new text. */
  targets(tool: string, input: Record<string, unknown>): Target[];
  /** The harness's answer to a denied call (stdout; exit code 0). */
  deny(reason: string): unknown;
}

const preToolUseDeny = (reason: string) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
});

interface Edit {
  old: unknown;
  new: unknown;
  all: boolean;
}

/** Applies string replacements the way the editors do; undefined when one does not apply. */
function applyEdits(before: string | undefined, edits: Edit[]): string | undefined {
  let text = before;
  for (const e of edits) {
    if (typeof e.old !== 'string' || typeof e.new !== 'string') return undefined;
    if (e.old === '') {
      // An empty old string creates the file.
      if (text !== undefined && text !== '') return undefined;
      text = e.new;
      continue;
    }
    if (text === undefined || !text.includes(e.old)) return undefined;
    text = e.all ? text.split(e.old).join(e.new) : text.replace(e.old, () => e.new as string);
  }
  return text;
}

const contentOf = (input: Record<string, unknown>) => () =>
  typeof input.content === 'string' ? input.content : undefined;

const ADAPTERS: Record<HookHarness, Adapter> = {
  claude: {
    writeTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    targets(tool, input) {
      if (tool === 'NotebookEdit') return [{ path: input.notebook_path, after: () => undefined }];
      if (tool === 'Write') return [{ path: input.file_path, after: contentOf(input) }];
      const raw = tool === 'MultiEdit' ? input.edits : [input];
      const edits: Edit[] | undefined = Array.isArray(raw)
        ? raw.map((e) =>
            isRecord(e)
              ? { old: e.old_string, new: e.new_string, all: e.replace_all === true }
              : { old: undefined, new: undefined, all: false },
          )
        : undefined;
      return [
        {
          path: input.file_path,
          after: (before) => (edits?.length ? applyEdits(before, edits) : undefined),
        },
      ];
    },
    deny: preToolUseDeny,
  },
  gemini: {
    writeTools: ['write_file', 'replace'],
    targets(tool, input) {
      if (tool === 'write_file') return [{ path: input.file_path, after: contentOf(input) }];
      const n = input.expected_replacements;
      const all = typeof n === 'number' && n > 1;
      return [
        {
          path: input.file_path,
          after: (before) =>
            applyEdits(before, [{ old: input.old_string, new: input.new_string, all }]),
        },
      ];
    },
    deny: (reason) => ({ decision: 'deny', reason }),
  },
  codex: {
    writeTools: ['apply_patch'],
    targets: (_tool, input) =>
      typeof input.command === 'string' ? patchTargets(input.command) : [],
    deny: preToolUseDeny,
  },
};

interface PatchOp {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo?: string;
  lines: string[];
}

const PATCH_OPS: [string, PatchOp['kind']][] = [
  ['*** Add File:', 'add'],
  ['*** Delete File:', 'delete'],
  ['*** Update File:', 'update'],
];

/** The file operations of a Codex apply_patch text (markers may carry surrounding whitespace). */
function parsePatch(patch: string): PatchOp[] {
  const ops: PatchOp[] = [];
  let op: PatchOp | undefined;
  for (const raw of patch.split('\n')) {
    const line = raw.trim();
    const marker = PATCH_OPS.find(([m]) => line.startsWith(m));
    if (marker) {
      op = { kind: marker[1], path: line.slice(marker[0].length).trim(), lines: [] };
      ops.push(op);
    } else if (line.startsWith('*** Move to:')) {
      if (op) op.moveTo = line.slice('*** Move to:'.length).trim();
    } else if (line === '*** Begin Patch' || line === '*** End Patch') {
      op = undefined;
    } else if (op && line !== '*** End of File') {
      op.lines.push(raw.replace(/\r$/, ''));
    }
  }
  return ops;
}

/** Index of `seq` in `lines` at or after `from`, exact first, then ignoring outer whitespace. */
function seek(lines: string[], seq: string[], from: number): number {
  for (const norm of [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim()]) {
    for (let i = from; i + seq.length <= lines.length; i++) {
      if (seq.every((s, j) => norm(lines[i + j] as string) === norm(s))) return i;
    }
  }
  return -1;
}

/** Applies the hunks of one "*** Update File" section; undefined when one does not apply. */
function applyHunks(before: string | undefined, body: string[]): string | undefined {
  if (before === undefined) return undefined;
  const hunks: { header?: string; old: string[]; new: string[] }[] = [];
  for (const line of body) {
    if (line.trim().startsWith('@@')) {
      const header = line.trim().slice(2).trim();
      hunks.push({ ...(header ? { header } : {}), old: [], new: [] });
      continue;
    }
    if (hunks.length === 0) hunks.push({ old: [], new: [] });
    const h = hunks[hunks.length - 1] as (typeof hunks)[number];
    const tag = line[0];
    const text = line.slice(1);
    if (line === '' || tag === ' ') {
      h.old.push(text);
      h.new.push(text);
    } else if (tag === '-') h.old.push(text);
    else if (tag === '+') h.new.push(text);
    else return undefined;
  }
  const file = before.split('\n');
  let cursor = 0;
  for (const h of hunks) {
    if (h.header) {
      const at = seek(file, [h.header], cursor);
      if (at < 0) return undefined;
      cursor = at + 1;
    }
    if (h.old.length === 0) {
      // Pure addition: at the end of the file.
      const end = file[file.length - 1] === '' ? file.length - 1 : file.length;
      file.splice(end, 0, ...h.new);
      continue;
    }
    const at = seek(file, h.old, cursor);
    if (at < 0) return undefined;
    file.splice(at, h.old.length, ...h.new);
    cursor = at + h.new.length;
  }
  return file.join('\n');
}

/** The files a Codex patch writes. Moving a file is not worked out (its targets are denied). */
function patchTargets(patch: string): Target[] {
  const out: Target[] = [];
  for (const op of parsePatch(patch)) {
    if (op.kind === 'delete') out.push({ path: op.path, after: () => '' });
    else if (op.kind === 'add') {
      const text = op.lines.map((l) => (l.startsWith('+') ? l.slice(1) : l)).join('\n');
      out.push({ path: op.path, after: () => `${text}\n` });
    } else if (op.moveTo !== undefined) {
      out.push({ path: op.path, after: () => undefined });
      out.push({ path: op.moveTo, after: () => undefined });
    } else out.push({ path: op.path, after: (before) => applyHunks(before, op.lines) });
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Picks the harness from the payload shape; undefined when it is none of the known ones. */
export function detectHarness(payload: unknown): HookHarness | undefined {
  if (!isRecord(payload)) return undefined;
  if (payload.hook_event_name === 'BeforeTool') return 'gemini';
  // Codex and Claude Code both send PreToolUse; Codex adds turn_id and names edits apply_patch.
  if (payload.tool_name === 'apply_patch' || typeof payload.turn_id === 'string') return 'codex';
  if (payload.hook_event_name === 'PreToolUse') return 'claude';
  const tool = payload.tool_name;
  if (typeof tool === 'string') {
    if (ADAPTERS.gemini.writeTools.includes(tool)) return 'gemini';
    if (ADAPTERS.claude.writeTools.includes(tool)) return 'claude';
  }
  return undefined;
}

/** True for a path whose extension is .bib, in any letter case. */
function isBibPath(path: string): boolean {
  return extname(path).toLowerCase() === '.bib';
}

/** What the guard reads from disk; tests replace it. */
export interface HookFs {
  /** The file's text; undefined when it does not exist. Throws when it cannot be read. */
  read(path: string): string | undefined;
  /** True when an overfull.yml is in `dir` or a folder above it (up to the git root). */
  inProject(dir: string): boolean;
}

export const nodeHookFs: HookFs = {
  read(path) {
    // One open file: its size and its text come from the same file, even if the
    // path is replaced in between.
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    try {
      if (fstatSync(fd).size > MAX_BIB_BYTES) throw new Error('too large');
      return readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  },
  inProject: (dir) => findConfigFile(dir) !== undefined,
};

/**
 * Decides one payload. `harness` is the adapter to use, or undefined to detect it.
 * `cwd` is where relative paths resolve when the payload has no `cwd` of its own.
 *
 * A write to a .bib file is allowed when no overfull.yml is found from the file's
 * folder upward (not an Overfull project), or when it only removes whole entries.
 * Anything else that writes a .bib file, or that cannot be worked out, is denied.
 */
export function decide(
  payload: unknown,
  harness: HookHarness | undefined,
  cwd: string,
  fs: HookFs = nodeHookFs,
): HookDecision {
  const allow: HookDecision = { allow: true };
  const deny: HookDecision = { allow: false, reason: DENY_REASON };
  const kind = harness ?? detectHarness(payload);
  if (!kind || !isRecord(payload)) return allow;
  const adapter = ADAPTERS[kind];
  const tool = payload.tool_name;
  if (typeof tool !== 'string' || !adapter.writeTools.includes(tool)) return allow;
  const input = payload.tool_input;
  if (!isRecord(input)) return allow;
  const base = typeof payload.cwd === 'string' && isAbsolute(payload.cwd) ? payload.cwd : cwd;
  for (const target of adapter.targets(tool, input)) {
    const path = target.path;
    if (typeof path !== 'string' || path === '' || path.includes('\0')) continue;
    const abs = isAbsolute(path) ? path : resolve(base, path);
    if (!isBibPath(abs)) continue;
    if (!fs.inProject(dirname(abs))) continue;
    let before: string | undefined;
    try {
      before = fs.read(abs);
    } catch {
      return deny;
    }
    const after = target.after(before);
    if (after === undefined || !onlyRemovesEntries(before ?? '', after)) return deny;
  }
  return allow;
}

/**
 * The text to print for a decision: nothing for allow, one JSON line for deny.
 * The exit code is 0 either way.
 */
function hookOutput(decision: HookDecision, harness: HookHarness): string {
  if (decision.allow) return '';
  return `${JSON.stringify(ADAPTERS[harness].deny(decision.reason))}\n`;
}

/** Parses stdin text; undefined when it is too large or not JSON. */
function parsePayload(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The whole `--hook` step: stdin text in, text to print out (empty means allow). */
export function runHook(
  stdinText: string,
  harness: HookHarness | undefined,
  cwd: string,
  fs: HookFs = nodeHookFs,
): { output: string; harness: HookHarness | undefined; decision: HookDecision } {
  const payload = parsePayload(stdinText);
  const kind = harness ?? detectHarness(payload);
  const decision = decide(payload, kind, cwd, fs);
  return { output: kind ? hookOutput(decision, kind) : '', harness: kind, decision };
}

// mend applies unified, SEARCH/REPLACE, V4A and JSON edits to a text-file tree, following SPEC.md.
// Node 22 and its standard library only; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

type Tier = 0 | 1 | 2;
type LineKind = 'context' | 'add' | 'remove';

interface PatchLine {
  kind: LineKind;
  text: string;
  noNewlineAfter?: boolean;
  rawEmpty?: boolean;
}

interface FileText {
  lines: string[];
  newline: string;
  ended: boolean;
}

function splitFile(text: string): FileText {
  const firstLf = text.indexOf('\n');
  const newline = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], newline, ended: false };
  const ended = text.endsWith(newline);
  const lines = text.split(newline);
  if (ended) lines.pop();
  return { lines, newline, ended };
}

function joinFile(lines: string[], newline: string, ended: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(newline) + (ended ? newline : '');
}

function normalizeLine(line: string, tier: Tier): string {
  if (tier === 0) return line;
  const rightTrimmed = line.replace(/[ \t]+$/, '');
  return tier === 1 ? rightTrimmed : rightTrimmed.replace(/^[ \t]+/, '');
}

function matchesAt(file: string[], old: string[], at: number, tier: Tier): boolean {
  return old.every((line, i) => normalizeLine(file[at + i]!, tier) === normalizeLine(line, tier));
}

function occurrences(file: string[], old: string[], from = 0, atEnd = false, strict = false): { tier: Tier; positions: number[] } | null {
  if (old.length === 0) return null;
  for (const tier of strict ? [0] as const : [0, 1, 2] as const) {
    const positions: number[] = [];
    for (let at = Math.max(0, from); at <= file.length - old.length; at++) {
      if ((!atEnd || at + old.length === file.length) && matchesAt(file, old, at, tier)) positions.push(at);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function firstOccurrence(file: string[], old: string[], from: number, atEnd = false, strict = false): { tier: Tier; position: number } | null {
  const found = occurrences(file, old, from, atEnd, strict);
  return found === null ? null : { tier: found.tier, position: found.positions[0]! };
}

function indent(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? '';
}

function reindent(line: string, prefix: string, replacement: string): string {
  if (line.trim() === '' || !line.startsWith(prefix)) return line;
  return replacement + line.slice(prefix.length);
}

function replacementLines(rows: PatchLine[], file: string[], at: number, tier: Tier): string[] {
  const oldRows = rows.filter((row) => row.kind !== 'add');
  const oldIndent = indent(oldRows[0]?.text ?? '');
  const fileIndent = indent(file[at] ?? '');
  const out: string[] = [];
  let consumed = 0;
  for (const row of rows) {
    if (row.kind === 'context') {
      out.push(file[at + consumed] ?? '');
      consumed++;
    } else if (row.kind === 'remove') {
      consumed++;
    } else {
      out.push(tier === 2 ? reindent(row.text, oldIndent, fileIndent) : row.text);
    }
  }
  return out;
}

function makeSearchEdit(path: string, old: string[], replacement: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (old.length === 0) {
      if (before !== null) throw new Fail('exists', path);
      tree.now.set(path, replacement.length === 0 ? '' : `${replacement.join('\n')}\n`);
      return;
    }
    if (before === null) throw new Fail('missing', path);
    const file = splitFile(before);
    const found = occurrences(file.lines, old, 0, false, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const at = found.positions[0]!;
    const changes = replacement.map((line) => found.tier === 2 ? reindent(line, indent(old[0]!), indent(file.lines[at]!)) : line);
    file.lines.splice(at, old.length, ...changes);
    tree.now.set(path, joinFile(file.lines, file.newline, file.ended));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousPath: string | null = null;
  let previousEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLine = i + 1;
    let separator = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (separator < 0 && lines[j]!.trimEnd() === '=======') separator = j;
      else if (separator >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (separator < 0 || end < 0) throw new Exit2(`error: parse ${searchLine}`);

    let path: string | null = null;
    for (let j = i - 1; j > previousEnd; j--) {
      const candidate = lines[j]!.trim();
      if (candidate !== '' && !candidate.startsWith('```')) {
        path = candidate;
        break;
      }
    }
    path ??= previousPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    const old = lines.slice(i + 1, separator);
    const replacement = lines.slice(separator + 1, end);
    edits.push(makeSearchEdit(path, old, replacement, strict));
    previousPath = path;
    previousEnd = end;
    i = end;
  }
  return edits;
}

interface UnifiedHunk {
  oldStart: number;
  rows: PatchLine[];
  noNewlineAtEnd: boolean;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hasDiffHeader: boolean;
  hasFileHeader: boolean;
  hunks: UnifiedHunk[];
}

function fileHeaderAt(lines: string[], at: number): boolean {
  return (lines[at] ?? '').startsWith('--- ') && (lines[at + 1] ?? '').startsWith('+++ ');
}

function headerPath(line: string): string {
  const raw = line.slice(4).split('\t', 1)[0]!.trim();
  return raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
}

function parseHunk(lines: string[], at: number): { hunk: UnifiedHunk; next: number } {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)$/.exec(lines[at]!);
  if (match === null) throw new Exit2(`error: parse ${at + 1}`);
  const rows: PatchLine[] = [];
  let i = at + 1;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ') || line.startsWith('@@') || fileHeaderAt(lines, i)) break;
    if (line.startsWith('\\')) {
      if (rows.length > 0) rows[rows.length - 1]!.noNewlineAfter = true;
      i++;
      continue;
    }
    if (line === '') {
      rows.push({ kind: 'context', text: '', rawEmpty: true });
      i++;
      continue;
    }
    const marker = line[0];
    if (marker === ' ' || marker === '+' || marker === '-') {
      rows.push({
        kind: marker === ' ' ? 'context' : marker === '+' ? 'add' : 'remove',
        text: line.slice(1),
      });
      i++;
      continue;
    }
    break;
  }
  while (rows.length > 0 && rows[rows.length - 1]!.rawEmpty) rows.pop();
  let lastOutput: PatchLine | undefined;
  for (const row of rows) if (row.kind !== 'remove') lastOutput = row;
  return {
    hunk: {
      oldStart: Number(match[1]),
      rows,
      noNewlineAtEnd: lastOutput?.noNewlineAfter === true,
    },
    next: i,
  };
}

function unifiedEdit(section: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    let oldPath = section.hasFileHeader ? section.oldPath : section.renameFrom ?? section.oldPath;
    let newPath = section.hasFileHeader ? section.newPath : section.renameTo ?? section.newPath;
    const isDelete = section.deletedFile || newPath === '/dev/null';
    const isCreate = section.newFile || oldPath === '/dev/null';
    if (isDelete) newPath = null;
    if (isCreate) oldPath = null;
    const sourcePath = oldPath;
    const destinationPath = newPath;
    if (sourcePath !== null && sourcePath !== '/dev/null' && !safe(sourcePath)) throw new Fail('unsafe', sourcePath);
    if (destinationPath !== null && destinationPath !== '/dev/null' && !safe(destinationPath)) throw new Fail('unsafe', destinationPath);

    if (isDelete) {
      const path = sourcePath;
      if (path === null || path === '/dev/null') throw new Fail('unsafe', path ?? '');
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }

    if (isCreate) {
      const path = destinationPath;
      if (path === null || path === '/dev/null') throw new Fail('unsafe', path ?? '');
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const added: string[] = [];
      let noNewline = false;
      for (const hunk of section.hunks) {
        for (const row of hunk.rows) {
          if (row.kind === 'add') {
            added.push(row.text);
            noNewline = row.noNewlineAfter === true;
          }
        }
      }
      tree.now.set(path, added.length === 0 ? '' : `${added.join('\n')}${noNewline ? '' : '\n'}`);
      return;
    }

    const path = sourcePath;
    if (path === null || path === '/dev/null') throw new Fail('unsafe', path ?? '');
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const moving = destinationPath !== null && destinationPath !== path;
    if (moving) {
      if (destinationPath === '/dev/null') throw new Fail('unsafe', destinationPath);
      if (tree.get(destinationPath) !== null) throw new Fail('exists', destinationPath);
    }

    const file = splitFile(before);
    let delta = 0;
    for (const hunk of section.hunks) {
      const old = hunk.rows.filter((row) => row.kind !== 'add').map((row) => row.text);
      const found = occurrences(file.lines, old, 0, false, strict);
      let at: number;
      let tier: Tier = 0;
      if (old.length === 0) {
        at = Math.min(file.lines.length, Math.max(0, hunk.oldStart + delta));
      } else {
        if (found === null) throw new Fail('no-match', path);
        const target = hunk.oldStart - 1 + delta;
        at = found.positions.reduce((best, candidate) =>
          Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best);
        tier = found.tier;
      }
      const replacement = replacementLines(hunk.rows, file.lines, at, tier);
      const reachesEnd = at + old.length === file.lines.length;
      file.lines.splice(at, old.length, ...replacement);
      if (reachesEnd) file.ended = !hunk.noNewlineAtEnd;
      delta += replacement.length - old.length;
    }
    const result = joinFile(file.lines, file.newline, file.ended);
    if (moving) {
      tree.now.set(path, null);
      tree.now.set(destinationPath!, result);
      tree.moves.push([path, destinationPath!]);
    } else {
      tree.now.set(path, result);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let current: UnifiedSection | null = null;
  const newSection = (oldPath: string | null, newPath: string | null, hasDiffHeader: boolean): UnifiedSection => ({
    oldPath,
    newPath,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hasDiffHeader,
    hasFileHeader: false,
    hunks: [],
  });

  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (match === null) throw new Exit2(`error: parse ${i + 1}`);
      current = newSection(match[1]!, match[2]!, true);
      sections.push(current);
      i++;
      continue;
    }
    if (fileHeaderAt(lines, i)) {
      if (current !== null && current.hasDiffHeader && !current.hasFileHeader && current.hunks.length === 0) {
        current.oldPath = headerPath(line);
        current.newPath = headerPath(lines[i + 1]!);
        current.hasFileHeader = true;
        i += 2;
        continue;
      }
      current = newSection(headerPath(line), headerPath(lines[i + 1]!), false);
      current.hasFileHeader = true;
      sections.push(current);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (current === null) throw new Exit2(`error: parse ${i + 1}`);
      if (current.deletedFile || current.newPath === '/dev/null') {
        i++;
        while (i < lines.length && !lines[i]!.startsWith('diff --git ') && !fileHeaderAt(lines, i)) i++;
        continue;
      }
      const parsed = parseHunk(lines, i);
      current.hunks.push(parsed.hunk);
      i = parsed.next;
      continue;
    }
    if (current !== null) {
      if (line.startsWith('--- ') && current.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('new file mode ')) current.newFile = true;
      else if (line.startsWith('deleted file mode ')) current.deletedFile = true;
      else if (line.startsWith('rename from ')) current.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) current.renameTo = line.slice(10).trim();
    }
    i++;
  }
  return sections.map((section) => unifiedEdit(section, strict));
}

interface V4AChunk {
  anchor: string;
  rows: PatchLine[];
  endOfFile: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  chunks: V4AChunk[];
  lines: string[];
  lineNumber: number;
}

function isV4ASection(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4ASection[] = [];
  for (let i = first + 1; i < last;) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const header = lines[i]!;
    const kind = header.startsWith('*** Add File: ') ? 'add' : header.startsWith('*** Delete File: ') ? 'delete' : header.startsWith('*** Update File: ') ? 'update' : null;
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? 14 : 17;
    const path = header.slice(prefix).trim();
    const lineNumber = i + 1;
    i++;
    const contentStart = i;
    while (i < last && !isV4ASection(lines[i]!)) i++;
    let contentEnd = i;
    while (contentEnd > contentStart && blank(lines[contentEnd - 1]!)) contentEnd--;
    const content = lines.slice(contentStart, contentEnd);
    const section: V4ASection = { kind, path, moveTo: null, chunks: [], lines: content, lineNumber };

    if (kind === 'add') {
      for (let j = 0; j < content.length; j++) {
        if (content[j] !== '' && !content[j]!.startsWith('+')) throw new Exit2(`error: parse ${contentStart + j + 1}`);
      }
      section.lines = content.map((line) => line === '' ? '' : line.slice(1));
    } else if (kind === 'delete') {
      const bad = content.findIndex((line) => line !== '');
      if (bad >= 0) throw new Exit2(`error: parse ${contentStart + bad + 1}`);
    } else {
      let j = 0;
      if (content[0]?.startsWith('*** Move to: ')) {
        section.moveTo = content[0]!.slice(13).trim();
        j++;
      }
      let chunk: V4AChunk | null = null;
      const finish = (): void => {
        if (chunk !== null) {
          section.chunks.push(chunk);
          chunk = null;
        }
      };
      for (; j < content.length; j++) {
        const line = content[j]!;
        if (line.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${contentStart + j + 1}`);
        if (line.startsWith('@@')) {
          finish();
          chunk = { anchor: line.slice(2).trim(), rows: [], endOfFile: false };
        } else if (line === '*** End of File') {
          if (chunk === null) chunk = { anchor: '', rows: [], endOfFile: true };
          else chunk.endOfFile = true;
          finish();
        } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
          chunk ??= { anchor: '', rows: [], endOfFile: false };
          chunk.rows.push({
            kind: line === '' || line[0] === ' ' ? 'context' : line[0] === '+' ? 'add' : 'remove',
            text: line === '' ? '' : line.slice(1),
          });
        } else {
          throw new Exit2(`error: parse ${contentStart + j + 1}`);
        }
      }
      finish();
      if (section.chunks.length === 0 && section.moveTo === null) throw new Exit2(`error: parse ${lineNumber}`);
    }
    sections.push(section);
  }

  return sections.map((section) => v4aEdit(section, strict));
}

function applyChunks(file: FileText, chunks: V4AChunk[], path: string, strict: boolean): void {
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== '') {
      const anchor = firstOccurrence(file.lines, [chunk.anchor], cursor, false, strict);
      if (anchor === null) throw new Fail('no-match', path);
      cursor = anchor.position + 1;
    }
    const old = chunk.rows.filter((row) => row.kind !== 'add').map((row) => row.text);
    let at = cursor;
    let tier: Tier = 0;
    if (old.length > 0) {
      const found = occurrences(file.lines, old, cursor, chunk.endOfFile, strict);
      if (found === null) throw new Fail('no-match', path);
      at = found.positions[0]!;
      tier = found.tier;
    } else if (chunk.endOfFile) {
      at = file.lines.length;
    } else {
      at = Math.min(cursor, file.lines.length);
    }
    const replacement = replacementLines(chunk.rows, file.lines, at, tier);
    file.lines.splice(at, old.length, ...replacement);
    cursor = at + replacement.length;
  }
}

function v4aEdit(section: V4ASection, strict: boolean): Edit {
  return (tree) => {
    const path = section.path;
    if (!safe(path)) throw new Fail('unsafe', path);
    if (section.kind === 'add') {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, section.lines.length === 0 ? '' : `${section.lines.join('\n')}\n`);
      return;
    }
    if (section.kind === 'update' && section.moveTo !== null && !safe(section.moveTo)) {
      throw new Fail('unsafe', section.moveTo);
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (section.kind === 'delete') {
      tree.now.set(path, null);
      return;
    }
    if (section.moveTo !== null) {
      if (tree.get(section.moveTo) !== null) throw new Fail('exists', section.moveTo);
    }
    const file = splitFile(before);
    applyChunks(file, section.chunks, path, strict);
    const result = joinFile(file.lines, file.newline, file.ended);
    if (section.moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(section.moveTo, result);
      tree.moves.push([path, section.moveTo]);
    } else {
      tree.now.set(path, result);
    }
  };
}


function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json' ? jsonEdits(text, lines) :
      kind === 'unified' ? unifiedEdits(lines, strict) :
      kind === 'search-replace' ? searchReplaceEdits(lines, strict) :
      kind === 'v4a' ? v4aEdits(lines, strict) : [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const paths = [...tree.now.keys()];
  const nextMove = new Map<string, string>();
  for (const [from, to] of tree.moves) {
    let replaced = false;
    for (const [origin, target] of nextMove) {
      if (target === from) {
        nextMove.set(origin, to);
        replaced = true;
      }
    }
    if (!replaced && tree.original(from) !== null) nextMove.set(from, to);
  }
  const renamed = new Map<string, string>();
  for (const [from, to] of nextMove) {
    if (tree.original(from) !== null && tree.get(from) === null && tree.original(to) === null && tree.get(to) !== null) {
      renamed.set(from, to);
    }
  }
  const renamedOld = new Set(renamed.keys());
  const renamedNew = new Set(renamed.values());
  const outputRows: { sort: string; line: string }[] = [];
  for (const [from, to] of renamed) outputRows.push({ sort: to, line: `R ${from} -> ${to}` });
  for (const p of paths) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (renamedOld.has(p) || renamedNew.has(p)) continue;
    outputRows.push({ sort: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  outputRows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
  const rows: string[] = outputRows.map((row) => row.line);
  if (!check) for (const p of paths) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

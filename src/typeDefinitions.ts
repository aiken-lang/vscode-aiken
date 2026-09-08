import * as fs from "fs";
import * as path from "path";

export interface TypeDecl {
  name: string;
  /** 0-indexed line where the type declaration starts */
  line: number;
}

export interface ConstructorDecl {
  name: string;
  /** 0-indexed line where the constructor starts */
  line: number;
  /** 0-indexed column where the constructor name starts */
  column: number;
}

export interface ImportedName {
  /** module path that declares the type */
  module: string;
  /** type name as declared in that module */
  name: string;
}

export interface ModuleImports {
  /** `use aiken/list` or `use aiken/list as l` -> alias -> full module path */
  moduleAliases: Map<string, string>;
  /** `use foo.{Bar as Baz}` -> Baz -> { module, name: Bar } */
  importedNames: Map<string, ImportedName>;
}

export type TypeRef =
  | { kind: "qualified"; module: string; name: string }
  | { kind: "alias"; module: string; name: string }
  | { kind: "imported"; module: string; name: string }
  | { kind: "bare"; name: string };

// Prelude types live inside the compiler and have no declaration to jump to.
const BUILTIN_TYPES = new Set([
  "Int",
  "Bool",
  "String",
  "ByteArray",
  "Data",
  "List",
  "Dict",
  "Pair",
  "Option",
  "Result",
  "Void",
  "Nil",
  "Some",
  "None",
  "Ok",
  "Error",
  "Ordering",
  "Map",
  "Set",
  "AssocList",
]);

const TYPE_DECL_REGEX = /^(?:(?:pub|opaque)\s+)*type\s+([A-Z][A-Za-z0-9_]*)/gm;

const USE_REGEX = new RegExp(
  "^use[ \\t]+([a-z][a-z0-9_]*(?:/[a-z0-9_]+)*)(?:[ \\t]+as[ \\t]+([a-z][a-z0-9_]*))?(?:[ \\t]*\\.[ \\t]*\\{([^}]*)\\})?",
  "gm",
);

// Aiken projects keep their sources directly at the root or under these dirs.
const SOURCE_ROOTS = ["lib", "validators", "tests"];

export function extractTypeDeclarations(text: string): TypeDecl[] {
  const decls: TypeDecl[] = [];
  let match: RegExpExecArray | null;
  TYPE_DECL_REGEX.lastIndex = 0;
  while ((match = TYPE_DECL_REGEX.exec(text)) !== null) {
    decls.push({ name: match[1], line: lineAt(text, match.index) });
  }
  return decls;
}

// Extracts the identifier-like token at `character` within a single line of
// text. Handles characters in `[A-Za-z0-9_/.]` (covers bare names, qualified
// paths like `foo/bar/Baz`, and alias-dot refs like `list.Datum`).
// Returns undefined when the cursor sits on whitespace/punctuation.
export function tokenAtPosition(
  lineText: string,
  character: number,
): string | undefined {
  if (character < 0 || character > lineText.length) {
    return undefined;
  }
  const startChar = lineText[character];
  if (!isTokenChar(startChar)) {
    return undefined;
  }

  let start = character;
  let end = character;
  while (start > 0 && isTokenChar(lineText[start - 1])) {
    start--;
  }
  while (end < lineText.length && isTokenChar(lineText[end])) {
    end++;
  }
  return lineText.slice(start, end);
}

function isTokenChar(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z0-9_./]$/.test(char);
}

// Scans type declarations for their constructor names.
//
// Handles:
//   pub type Color { Red | Green }
//   pub type Thing { Thing(x: Int) }          (multi-line preferred)
//   pub type Pair(a, b) {
//     Pair { fst: a, snd: b }
//   }
//   opaque type Wrapped { Wrapped { x: Int } }
//
// Skips type aliases (`type X = Y`) and only collects constructors at the
// declaration's top level. Returns the constructor's line & column so we can
// jump to the constructor name itself, not just the `type` keyword.
export function extractTypeConstructors(text: string): ConstructorDecl[] {
  const constructors: ConstructorDecl[] = [];
  const lines = text.split("\n");

  let line = 0;
  while (line < lines.length) {
    const trimmed = lines[line].trim();
    const typeMatch = /^(?:(?:pub|opaque)\s+)*type\s+([A-Z][A-Za-z0-9_\s(,)]*)=?[\s\S]*/.exec(
      trimmed,
    );
    if (!typeMatch) {
      line++;
      continue;
    }
    if (trimmed.includes("=")) {
      line++;
      continue;
    }

    const openBrace = trimmed.indexOf("{");
    if (openBrace === -1) {
      line++;
      continue;
    }

    const scanLine = (source: string, lineIndex: number): void => {
      const content = stripLeadingWhitespaceAndDocs(source);
      if (!content || content.startsWith("}")) {
        return;
      }
      const constructorMatch = /^([A-Z][A-Za-z0-9_]*)/.exec(content);
      if (constructorMatch) {
        constructors.push({
          name: constructorMatch[1],
          line: lineIndex,
          column: source.indexOf(constructorMatch[1]),
        });
      }
    };

    // The remainder of the declaration line after `{` is body content: the
    // first constructor follows immediately, then `|`-separated alternatives.
    if (trimmed.slice(openBrace + 1).trim().length > 0) {
      scanLine(trimmed.slice(openBrace + 1), line);
    }

    let braceDepth = 0;
    for (let offset = openBrace; offset < trimmed.length; offset++) {
      if (trimmed[offset] === "{") {
        braceDepth++;
      } else if (trimmed[offset] === "}") {
        braceDepth--;
      }
      if (braceDepth === 1 && trimmed[offset] === "|") {
        const afterPipe = trimmed.slice(offset + 1).trimStart();
        if (/^[A-Z]/.test(afterPipe)) {
          const m = /^([A-Z][A-Za-z0-9_]*)/.exec(afterPipe)!;
          constructors.push({
            name: m[1],
            line,
            column: trimmed.indexOf(m[1]),
          });
        }
      }
    }

    line++;
    while (line < lines.length && braceDepth > 0) {
      const currentLine = lines[line];
      const content = stripLeadingWhitespaceAndDocs(currentLine);
      if (braceDepth === 1 && content.length > 0) {
        scanLine(currentLine, line);
      }
      braceDepth +=
        countChar(currentLine, "{") - countChar(currentLine, "}");
      line++;
    }
  }

  return constructors;
}

function countChar(s: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) {
      count++;
    }
  }
  return count;
}

function stripLeadingWhitespaceAndDocs(line: string): string {
  let trimmed = line.trimStart();
  while (trimmed.startsWith("///") || trimmed.startsWith("/// ")) {
    trimmed = trimmed.slice(3).trimStart();
  }
  return trimmed.trimStart();
}

export function extractModuleImports(text: string): ModuleImports {
  const moduleAliases = new Map<string, string>();
  const importedNames = new Map<string, ImportedName>();

  let match: RegExpExecArray | null;
  USE_REGEX.lastIndex = 0;
  while ((match = USE_REGEX.exec(text)) !== null) {
    const modulePath = match[1];
    const explicitAlias = match[2];
    const braces = match[3];

    const defaultAlias = lastSegment(modulePath);
    if (defaultAlias) {
      moduleAliases.set(defaultAlias, modulePath);
    }
    if (explicitAlias) {
      moduleAliases.set(explicitAlias, modulePath);
    }

    if (braces) {
      for (const item of parseBraces(braces)) {
        if (/^[A-Z]/.test(item.original)) {
          importedNames.set(item.alias ?? item.original, {
            module: modulePath,
            name: item.original,
          });
        }
      }
    }
  }

  return { moduleAliases, importedNames };
}

export function moduleForUri(
  filePath: string,
  workspaceRoots: string[],
): string | undefined {
  if (path.extname(filePath) !== ".ak") {
    return undefined;
  }

  const aikenRoot = findNearestAikenDir(path.dirname(filePath));
  const base = aikenRoot ?? containingWorkspaceRoot(filePath, workspaceRoots);
  if (!base) {
    return undefined;
  }

  let relative = path.relative(base, filePath).split(path.sep).join("/");
  relative = relative.replace(/\.ak$/, "");

  for (const dir of SOURCE_ROOTS) {
    if (relative.startsWith(dir + "/")) {
      return relative.slice(dir.length + 1);
    }
  }

  return relative;
}

export function isBuiltin(name: string): boolean {
  return BUILTIN_TYPES.has(name);
}

export function resolveTypeRef(
  token: string,
  imports: ModuleImports,
): TypeRef | undefined {
  const lastSeparator = Math.max(
    token.lastIndexOf("/"),
    token.lastIndexOf("."),
  );
  const lastName = token.slice(lastSeparator + 1);

  if (!/^[A-Z]/.test(lastName)) {
    return undefined;
  }

  const slashIndex = token.lastIndexOf("/");
  if (slashIndex !== -1) {
    if (isBuiltin(lastName)) {
      return undefined;
    }
    const module = token.slice(0, slashIndex);
    if (!module) {
      return undefined;
    }
    return { kind: "qualified", module, name: lastName };
  }

  const dotIndex = token.lastIndexOf(".");
  if (dotIndex !== -1) {
    if (isBuiltin(lastName)) {
      return undefined;
    }
    const alias = token.slice(0, dotIndex);
    const module = imports.moduleAliases.get(alias);
    if (!module) {
      return undefined;
    }
    return { kind: "alias", module, name: lastName };
  }

  const imported = imports.importedNames.get(token);
  if (imported) {
    return { kind: "imported", module: imported.module, name: imported.name };
  }

  if (isBuiltin(token)) {
    return undefined;
  }

  return { kind: "bare", name: token };
}

function parseBraces(content: string): Array<{ original: string; alias?: string }> {
  const items: Array<{ original: string; alias?: string }> = [];
  for (const raw of content.split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z][A-Za-z0-9_]*))?$/.exec(
      trimmed,
    );
    if (match) {
      items.push({ original: match[1], alias: match[2] });
    }
  }
  return items;
}

function lastSegment(modulePath: string): string | undefined {
  const index = modulePath.lastIndexOf("/");
  return modulePath.slice(index + 1);
}

function lineAt(text: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
    }
  }
  return line;
}

function findNearestAikenDir(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, "aiken.toml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function containingWorkspaceRoot(
  file: string,
  workspaceRoots: string[],
): string | undefined {
  let best: string | undefined;
  let bestLength = -1;
  for (const root of workspaceRoots) {
    const resolved = path.resolve(root);
    if (file.startsWith(resolved + path.sep) && resolved.length > bestLength) {
      best = resolved;
      bestLength = resolved.length;
    }
  }
  return best;
}
import { ModuleImports } from "./typeDefinitions";

export interface ConstantDecl {
  name: string;
  /** 0-indexed line where the declaration starts */
  line: number;
  /** only `pub const` can be referenced from another module */
  isPublic: boolean;
  /** the whole declaration as written, possibly spanning several lines */
  source: string;
}

export type ConstantRef =
  | { kind: "local"; name: string }
  | { kind: "imported"; module: string; name: string; localName: string }
  | { kind: "qualified"; module: string; name: string; qualifier: string };

const CONST_DECL_REGEX = /^(pub\s+)?const\s+([a-z_][a-z0-9_]*)\b/;
const TOP_LEVEL_DECL_REGEX =
  /^(?:(?:pub|opaque)\s+)*(?:fn|test|bench|validator|const|type|use)\b/;
// Everything that introduces parameters: functions (named or anonymous), tests,
// validators and validator handlers.
const PARAMETER_LIST_REGEX =
  /\b(?:fn(?:\s+\w+)?|(?:test|bench|validator)\s+\w+|spend|mint|withdraw|publish|vote|propose|else)\s*\(/g;

export function extractConstants(text: string): ConstantDecl[] {
  const lines = text.split("\n");
  const constants: ConstantDecl[] = [];

  lines.forEach((lineText, line) => {
    const match = CONST_DECL_REGEX.exec(lineText);
    if (!match) {
      return;
    }
    const end = findDeclarationEnd(lines, line);
    constants.push({
      name: match[2],
      line,
      isPublic: match[1] !== undefined,
      source: lines
        .slice(line, end + 1)
        .join("\n")
        .trimEnd(),
    });
  });

  return constants;
}

// Finds the constant a cursor position refers to, or undefined when the cursor
// is on anything that cannot be one: a string, a comment, a record label, a
// field access, a module path...
export function constantRefAtPosition(
  lineText: string,
  character: number,
  imports: ModuleImports,
): ConstantRef | undefined {
  const code = blankNonCode(lineText);
  if (character < 0 || !isWordChar(code[character])) {
    return undefined;
  }

  let start = character;
  let end = character;
  while (start > 0 && isWordChar(code[start - 1])) {
    start--;
  }
  while (end < code.length && isWordChar(code[end])) {
    end++;
  }

  const word = code.slice(start, end);
  if (!/^[a-z_]/.test(word)) {
    return undefined;
  }
  // `label: value` in records, and annotated parameters.
  if (code.slice(end).trimStart().startsWith(":")) {
    return undefined;
  }
  // The segments of `use some/module` are not values, but what's in braces is.
  if (/^use\b/.test(code) && !code.slice(0, start).includes("{")) {
    return undefined;
  }

  const qualifierEnd = code[start - 1] === "." ? start - 1 : undefined;
  // `..rest` is a spread rather than an access, so it reads as a bare name.
  if (qualifierEnd === undefined || code[qualifierEnd - 1] === ".") {
    const imported = imports.importedValues.get(word);
    return imported
      ? { kind: "imported", ...imported, localName: word }
      : { kind: "local", name: word };
  }

  let qualifierStart = qualifierEnd;
  while (qualifierStart > 0 && isWordChar(code[qualifierStart - 1])) {
    qualifierStart--;
  }
  const qualifier = code.slice(qualifierStart, qualifierEnd);
  // `a.b.c` and `foo().c` access fields; only `module.c` can be a constant.
  if (!qualifier || code[qualifierStart - 1] === ".") {
    return undefined;
  }
  const module = imports.moduleAliases.get(qualifier);
  return module ? { kind: "qualified", module, name: word, qualifier } : undefined;
}

// Whether `name` is bound locally at `line`, in which case it hides any
// constant of the same name. This reads the enclosing declaration without
// tracking block scopes, so a binding from an already closed block also counts:
// we'd rather show nothing than show an unrelated constant's value.
export function isLocallyBound(text: string, line: number, name: string): boolean {
  const lines = text.split("\n");
  let start = Math.min(line, lines.length - 1);
  while (start > 0 && !TOP_LEVEL_DECL_REGEX.test(lines[start])) {
    start--;
  }
  const code = lines
    .slice(start, line + 1)
    .map(blankNonCode)
    .join("\n");

  const word = `\\b${name}\\b`;
  const isBoundByStatement = [
    // `let x = ..`, `expect Some(x) = ..`, but neither `expect x == ..` nor `let y = x`
    new RegExp(`\\b(?:let|expect)\\b[^=\\n]*${word}[^=\\n]*(?<![<>!])=(?!=)`),
    // backpassing: `x <- ..`, `let x <- ..`
    new RegExp(`${word}[^=\\n]*<-`),
    // `when` branch patterns: `Some(x) -> ..`
    new RegExp(`^.*${word}.*->`, "m"),
  ].some((regex) => regex.test(code));

  return isBoundByStatement || parameterLists(code).some((list) => new RegExp(word).test(list));
}

function parameterLists(code: string): string[] {
  const lists: string[] = [];
  for (const match of code.matchAll(PARAMETER_LIST_REGEX)) {
    const open = match.index! + match[0].length;
    let depth = 1;
    let close = open;
    while (close < code.length && depth > 0) {
      depth += bracketDelta(code[close]);
      close++;
    }
    lists.push(code.slice(open, close));
  }
  return lists;
}

function findDeclarationEnd(lines: string[], start: number): number {
  let depth = 0;
  for (let line = start; line < lines.length; line++) {
    for (const char of blankNonCode(lines[line])) {
      depth += bracketDelta(char);
    }
    const isContinued = /^[ \t]+\S/.test(lines[line + 1] ?? "");
    if (depth <= 0 && !isContinued) {
      return line;
    }
  }
  return lines.length - 1;
}

// Replaces string contents and comments by spaces, so that columns still line up
// with the original text and whatever is left is code.
function blankNonCode(line: string): string {
  let result = "";
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inString) {
      if (char === "\\") {
        result += " ";
        i++;
        if (i < line.length) {
          result += " ";
        }
        continue;
      }
      inString = char !== '"';
      result += " ";
    } else if (char === "/" && line[i + 1] === "/") {
      return result.padEnd(line.length);
    } else if (char === '"') {
      inString = true;
      result += " ";
    } else {
      result += char;
    }
  }
  return result;
}

function bracketDelta(char: string): number {
  if ("([{".includes(char)) {
    return 1;
  }
  return ")]}".includes(char) ? -1 : 0;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /^\w$/.test(char);
}

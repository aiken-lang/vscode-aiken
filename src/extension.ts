import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import {
  ConstructorDecl,
  TypeRef,
  extractModuleImports,
  extractTypeConstructors,
  extractTypeDeclarations,
  moduleForUri,
  resolveTypeRef,
  tokenAtPosition,
  TypeDecl,
} from "./typeDefinitions";
import {
  ConstantDecl,
  constantRefAtPosition,
  extractConstants,
  isLocallyBound,
} from "./constants";

let client: LanguageClient | undefined;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(_context: vscode.ExtensionContext) {
  let clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "aiken" }],
    synchronize: {
      fileEvents: [
        vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            vscode.workspace.workspaceFolders
              ? vscode.workspace.workspaceFolders[0]
              : ".",
            "aiken.toml",
          ),
        ),
      ],
    },
  };

  let serverOptions: ServerOptions = {
    command: "aiken",
    args: ["lsp"],
    transport: TransportKind.stdio,
    options: {
      env: Object.assign(process.env, {}),
    },
  };

  client = new LanguageClient(
    "aiken_language_server",
    "Aiken Language Server",
    serverOptions,
    clientOptions,
  );

  client.start();

  const typeIndex = new AikenTypeIndex();
  _context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { language: "aiken", scheme: "file" },
      new AikenTypeDefinitionProvider(typeIndex),
    ),
    vscode.languages.registerHoverProvider(
      { language: "aiken", scheme: "file" },
      new AikenConstantHoverProvider(typeIndex),
    ),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.languageId === "aiken" && document.uri.scheme === "file") {
        typeIndex.reset();
      }
    }),
  );
}

// This method is called when your extension is deactivated
export function deactivate() {
  return client?.stop();
}

function workspaceRoots(): string[] {
  return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
}

class AikenTypeIndex {
  private types = new Map<string, Map<string, vscode.Location[]>>();
  private constructors = new Map<string, Map<string, vscode.Location[]>>();
  private constants = new Map<string, ConstantDecl[]>();
  private built = false;
  private building: Promise<void> | undefined;
  private generation = 0;

  reset(): void {
    this.generation++;
    this.built = false;
    this.building = undefined;
    this.types.clear();
    this.constructors.clear();
    this.constants.clear();
  }

  async ensure(): Promise<void> {
    if (this.built) {
      return;
    }
    if (this.building) {
      return this.building;
    }
    this.building = this.build();
    return this.building;
  }

  private async build(): Promise<void> {
    const generation = this.generation;
    const roots = workspaceRoots();

    let files: vscode.Uri[] = [];
    try {
      files = await vscode.workspace.findFiles(
        "**/*.ak",
        "**/{build,target,node_modules,.git}/**",
      );
    } catch {
      // No workspace / findFiles unavailable: same-file resolution still works.
    }

    const types = new Map<string, Map<string, vscode.Location[]>>();
    const constructors = new Map<string, Map<string, vscode.Location[]>>();
    const constants = new Map<string, ConstantDecl[]>();

    for (const uri of files) {
      const moduleName = moduleForUri(uri.fsPath, roots);
      if (!moduleName) {
        continue;
      }

      let text: string;
      try {
        text = (await vscode.workspace.fs.readFile(uri)).toString();
      } catch {
        continue;
      }

      recordLocations(types, moduleName, extractTypeDeclarations(text), uri);
      recordLocations(constructors, moduleName, extractTypeConstructors(text), uri);
      constants.set(moduleName, extractConstants(text));
    }

    if (generation !== this.generation) {
      return;
    }

    this.types = types;
    this.constructors = constructors;
    this.constants = constants;
    this.built = true;
    this.building = undefined;
  }

  publicConstant(moduleName: string, name: string): ConstantDecl | undefined {
    return this.constants
      .get(moduleName)
      ?.find((constant) => constant.isPublic && constant.name === name);
  }

  locationsFor(moduleName: string, name: string): vscode.Location[] | undefined {
    const types = this.types.get(moduleName)?.get(name);
    if (types && types.length > 0) {
      return types;
    }
    return this.constructors.get(moduleName)?.get(name);
  }

  allTypesForName(name: string): vscode.Location[] {
    const results: vscode.Location[] = [];
    for (const moduleTypes of this.types.values()) {
      const locations = moduleTypes.get(name);
      if (locations) {
        results.push(...locations);
      }
    }
    return results;
  }

  allConstructorsForName(name: string): vscode.Location[] {
    const results: vscode.Location[] = [];
    for (const moduleConstructors of this.constructors.values()) {
      const locations = moduleConstructors.get(name);
      if (locations) {
        results.push(...locations);
      }
    }
    return results;
  }
}

function recordLocations(
  map: Map<string, Map<string, vscode.Location[]>>,
  moduleName: string,
  decls: TypeDecl[] | ConstructorDecl[],
  uri: vscode.Uri,
): void {
  if (decls.length === 0) {
    return;
  }
  let names = map.get(moduleName);
  if (!names) {
    names = new Map();
    map.set(moduleName, names);
  }
  for (const decl of decls) {
    let locations = names.get(decl.name);
    if (!locations) {
      locations = [];
      names.set(decl.name, locations);
    }
    const hasColumn = "column" in decl;
    const column = hasColumn ? (decl as ConstructorDecl).column : 0;
    locations.push(new vscode.Location(uri, new vscode.Position(decl.line, column)));
  }
}

class AikenTypeDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly index: AikenTypeIndex) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Definition | undefined> {
    const token = tokenAtPosition(
      document.lineAt(position.line).text,
      position.character,
    );
    if (!token) {
      // Not an identifier; leave to the Aiken language server.
      return undefined;
    }
    const text = document.getText();
    const roots = workspaceRoots();
    const currentModule = moduleForUri(document.uri.fsPath, roots);

    const imports = extractModuleImports(text);
    const ref = resolveTypeRef(token, imports);
    if (!ref) {
      return undefined;
    }

    const currentDecls = extractTypeDeclarations(text);
    const currentConstructors = extractTypeConstructors(text);

    try {
      return await this.resolveImpl(
        document,
        ref,
        currentModule,
        currentDecls,
        currentConstructors,
      );
    } catch (err) {
      console.error("[type-def] error:", err);
      return undefined;
    }
  }

  private async resolveImpl(
    document: vscode.TextDocument,
    ref: TypeRef,
    currentModule: string | undefined,
    currentDecls: TypeDecl[],
    currentConstructors: ConstructorDecl[],
  ): Promise<vscode.Definition | undefined> {
    // Same-file resolution never depends on the workspace index, so resolve it
    // first (and return early when possible) to stay robust even if the index
    // build fails (e.g. no workspace folder in the dev host).
    if (ref.kind === "bare") {
      const sameFile = resolveInModule(
        document,
        currentDecls,
        currentConstructors,
        ref.name,
      );
      if (sameFile.length > 0) {
        return sameFile;
      }
    }

    let index: AikenTypeIndex;
    try {
      await this.index.ensure();
      index = this.index;
    } catch (err) {
      console.error("[type-def] index build failed", err);
      return undefined;
    }

    if (ref.kind === "bare") {
      // Type-first across the workspace: a name that is both a type and a
      // constructor (extremely common: `pub type Thing { Thing(x) }`) resolves
      // to the type unless no type matches.
      const typeLocations = index.allTypesForName(ref.name);
      if (typeLocations.length > 0) {
        return typeLocations;
      }
      const ctorLocations = index.allConstructorsForName(ref.name);
      return ctorLocations.length > 0 ? ctorLocations : undefined;
    }

    // qualified / alias / imported: resolve inside the target module (or the
    // current module when that's where the reference points).
    const inCurrentModule =
      ref.module === currentModule
        ? resolveInModule(document, currentDecls, currentConstructors, ref.name)
        : [];
    const fromIndex = index.locationsFor(ref.module, ref.name) ?? [];
    const results = dedupeLocations([...inCurrentModule, ...fromIndex]);
    return results.length > 0 ? results : undefined;
  }
}

class AikenConstantHoverProvider implements vscode.HoverProvider {
  constructor(private readonly index: AikenTypeIndex) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const text = document.getText();
    const ref = constantRefAtPosition(
      document.lineAt(position.line).text,
      position.character,
      extractModuleImports(text),
    );
    if (!ref) {
      return undefined;
    }

    const boundName =
      ref.kind === "local"
        ? ref.name
        : ref.kind === "imported"
          ? ref.localName
          : ref.qualifier;
    if (isLocallyBound(text, position.line, boundName)) {
      return undefined;
    }

    if (ref.kind === "local") {
      const constant = extractConstants(text).find((c) => c.name === ref.name);
      return constant && constantHover(constant);
    }

    try {
      await this.index.ensure();
    } catch (err) {
      console.error("[constant-hover] index build failed", err);
      return undefined;
    }
    const constant = this.index.publicConstant(ref.module, ref.name);
    return constant && constantHover(constant);
  }
}

function constantHover(constant: ConstantDecl): vscode.Hover {
  const contents = new vscode.MarkdownString();
  contents.appendCodeblock(constant.source, "aiken");
  return new vscode.Hover(contents);
}

function resolveInModule(
  document: vscode.TextDocument,
  decls: TypeDecl[],
  constructors: ConstructorDecl[],
  name: string,
): vscode.Location[] {
  const typeLocations = decls
    .filter((decl) => decl.name === name)
    .map(
      (decl) =>
        new vscode.Location(document.uri, new vscode.Position(decl.line, 0)),
    );
  if (typeLocations.length > 0) {
    return typeLocations;
  }
  return constructors
    .filter((ctor) => ctor.name === name)
    .map(
      (ctor) =>
        new vscode.Location(
          document.uri,
          new vscode.Position(ctor.line, ctor.column),
        ),
    );
}

function dedupeLocations(locations: vscode.Location[]): vscode.Location[] {
  const seen = new Set<string>();
  const results: vscode.Location[] = [];
  for (const location of locations) {
    const key = `${location.uri.toString()}:${location.range.start.line}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push(location);
    }
  }
  return results;
}
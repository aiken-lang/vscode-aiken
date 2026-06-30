// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
/*eslint curly: ["error", "multi-line"]*/
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

import * as fs from "fs";
import * as path from "path";

function resolveAikenBinary(
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  configuredPath: string | undefined,
): string {
  // 1. User/workspace config
  if (configuredPath && fs.existsSync(configuredPath)) {
    output.appendLine(`Using aiken.executablePath`);
    return configuredPath;
  }

  // 2. Workspace ./bin/aiken
  const binaryName = process.platform === "win32" ? "aiken.exe" : "aiken";
  for (const workspaceFolder of workspaceFolders) {
    const localAiken = path.join(workspaceFolder.uri.fsPath, "bin", binaryName);
    if (fs.existsSync(localAiken)) {
      return localAiken;
    }
  }

  // 3. Fallback PATH
  return binaryName;
}
const output = vscode.window.createOutputChannel("Aiken");

let client: LanguageClient | undefined;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(_context: vscode.ExtensionContext) {
  _context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("aiken.executablePath") ||
        e.affectsConfiguration("aiken.workspaceFolderIdx")
      ) {
        // output.appendLine("Reload to apply Aiken config");
        vscode.window.showInformationMessage("Reload to apply Aiken config");
      }
    }),
  );

  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  // output.appendLine("Aiken extension activated");
  // output.show();
  vscode.window.showInformationMessage("Aiken extension activated");

  if (workspaceFolders.length > 0) {
    workspaceFolders.forEach((f, i) => {
      output.appendLine(`workspace[${i}]: ${f.uri.fsPath}`);
    });

    const config = vscode.workspace.getConfiguration("aiken");
    // output.appendLine(`config: ${JSON.stringify(config)}`);
    const idx = parseInt(
      config.get<number>("workspaceFolderIdx")?.toString() || "-1",
    );
    output.appendLine(`aiken.workspaceFolderIdx: ${idx}`);
    let execPath = config.get<string>("executablePath");
    if (execPath?.includes("${workspaceFolder}")) {
      const folder =
        idx >= 0 && workspaceFolders[idx]
          ? workspaceFolders[idx]
          : workspaceFolders[0];

      execPath = execPath.replace("${workspaceFolder}", folder.uri.fsPath);
    }

    let clientOptions: LanguageClientOptions = {
      documentSelector: [{ scheme: "file", language: "aiken" }],
      synchronize: {
        fileEvents: [
          vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(
              idx >= 0 && workspaceFolders[idx]
                ? workspaceFolders[idx]
                : workspaceFolders[0],
              "aiken.toml",
            ),
          ),
        ],
      },
    };

    const resolved = resolveAikenBinary(workspaceFolders, execPath);
    output.appendLine(`aiken path: ${resolved}`);

    let serverOptions: ServerOptions = {
      command: resolved,
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
    await client.start();

    _context.subscriptions.push(client);
  }
}

// This method is called when your extension is deactivated
export async function deactivate() {
  return await client?.stop();
}

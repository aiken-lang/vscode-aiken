// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(_context: vscode.ExtensionContext) {
  let clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "aiken" }],
    synchronize: {
      fileEvents: [
        vscode.workspace.createFileSystemWatcher("**/aiken.toml"),
        vscode.workspace.createFileSystemWatcher("**/manifest.toml"),
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
    clientOptions
  );

  client.start();
}

// This method is called when your extension is deactivated
export function deactivate() {
  return client?.stop();
}

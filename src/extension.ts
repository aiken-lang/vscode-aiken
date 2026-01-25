// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode'
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node'
import { AikenDefinitionProvider } from './definitionProvider'
import { AikenHoverProvider } from './hoverProvider'

let clients: Map<string, LanguageClient> = new Map()

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	// Register client-side providers
	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider({ scheme: 'file', language: 'aiken' }, new AikenDefinitionProvider()),
		vscode.languages.registerHoverProvider({ scheme: 'file', language: 'aiken' }, new AikenHoverProvider())
	)

	const startClient = async (projectRoot: string) => {
		if (clients.has(projectRoot)) {
			return
		}

		let clientOptions: LanguageClientOptions = {
			documentSelector: [
				{
					scheme: 'file',
					language: 'aiken',
					pattern: `${projectRoot}/**/*`
				},
				{
					scheme: 'file',
					language: 'aiken',
					pattern: `${projectRoot}/*.ak`
				}
			],
			synchronize: {
				fileEvents: [vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(projectRoot, 'aiken.toml'))]
			},
			workspaceFolder: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectRoot))
		}

		let serverOptions: ServerOptions = {
			command: 'aiken',
			args: ['lsp'],
			transport: TransportKind.stdio,
			options: {
				env: Object.assign(process.env, {}),
				cwd: projectRoot
			}
		}

		const client = new LanguageClient('aiken_language_server', 'Aiken Language Server', serverOptions, clientOptions)

		client.start()
		clients.set(projectRoot, client)
	}

	const stopClient = async (projectRoot: string) => {
		const client = clients.get(projectRoot)
		if (client) {
			await client.stop()
			clients.delete(projectRoot)
		}
	}

	// Helper: check if a new root is a subdirectory of an existing active root
	const isNested = (newRoot: string) => {
		for (const activeRoot of clients.keys()) {
			if (newRoot.startsWith(activeRoot) && newRoot.length > activeRoot.length) {
				return true
			}
		}
		return false
	}

	// Helper: check if path contains ignored segments
	const isIgnored = (uri: vscode.Uri) => {
		const segments = uri.path.split('/')
		return segments.includes('build') || segments.includes('packages')
	}

	// Find all aiken.toml files in the workspace
	const aikenFiles = await vscode.workspace.findFiles('**/aiken.toml')

	// Sort by path length (ascending) so we process top-level projects first
	aikenFiles.sort((a, b) => a.fsPath.length - b.fsPath.length)

	for (const file of aikenFiles) {
		if (isIgnored(file)) {
			continue
		}

		const projectRoot = vscode.Uri.joinPath(file, '..').fsPath
		if (!isNested(projectRoot)) {
			await startClient(projectRoot)
		}
	}

	// Watch for changes to aiken.toml files
	const watcher = vscode.workspace.createFileSystemWatcher('**/aiken.toml')
	watcher.onDidCreate(async uri => {
		if (isIgnored(uri)) {
			return
		}

		const projectRoot = vscode.Uri.joinPath(uri, '..').fsPath
		if (!isNested(projectRoot)) {
			await startClient(projectRoot)
		}
	})
	watcher.onDidDelete(async uri => {
		const projectRoot = vscode.Uri.joinPath(uri, '..').fsPath
		await stopClient(projectRoot)
	})

	context.subscriptions.push(watcher)
}

// This method is called when your extension is deactivated
export async function deactivate() {
	const promises: Promise<void>[] = []
	for (const client of clients.values()) {
		promises.push(client.stop())
	}
	await Promise.all(promises)
}

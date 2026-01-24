import * as vscode from 'vscode';

export class AikenDefinitionProvider implements vscode.DefinitionProvider {
    public async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Definition | undefined> {
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) return;

        const word = document.getText(wordRange);
        const definitions: vscode.Location[] = [];

        // 1. Search in the current document first
        const localDef = this.findDefinitionInText(document.getText(), word, document.uri);
        if (localDef) {
            definitions.push(localDef);
        }

        // 2. Search in other workspace files
        // Include standard Aiken lib and build directories explicitly
        const files = await vscode.workspace.findFiles('{**/*.ak,lib/**/*.ak,build/packages/**/lib/**/*.ak}');
        
        for (const file of files) {
            if (file.toString() === document.uri.toString()) continue; // Skip current file

            const doc = await vscode.workspace.openTextDocument(file);
            const def = this.findDefinitionInText(doc.getText(), word, file);
            if (def) {
                definitions.push(def);
            }
        }

        return definitions.length > 0 ? definitions : undefined;
    }

    private findDefinitionInText(text: string, name: string, uri: vscode.Uri): vscode.Location | undefined {
        // Regex for function definitions: fn name(...)
        const fnRegex = new RegExp(`\\bfn\\s+(${name})\\b`, 'g');
            // Regex for type definitions: type Name
        const typeRegex = new RegExp(`\\btype\\s+(${name})\\b`, 'g');
        // Regex for validators: validator(name) or just validator name
        const validatorRegex = new RegExp(`\\bvalidator\\s+(${name})\\b`, 'g');
        // Regex for local bindings: let name, expect name
        const letRegex = new RegExp(`\\blet\\s+(${name})\\b`, 'g');
        const expectRegex = new RegExp(`\\bexpect\\s+(${name})\\b`, 'g');
        
        const lines = text.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Skip comment lines
            if (line.trim().startsWith('//')) continue;
            
            // For workspace files (not current), skip local bindings (let/expect) to avoid noise
            const isCurrentFile = uri.toString() === vscode.window.activeTextEditor?.document.uri.toString();
            const matchLocal = isCurrentFile && (letRegex.test(line) || expectRegex.test(line));
            const matchGlobal = fnRegex.test(line) || typeRegex.test(line) || validatorRegex.test(line);

            if (matchGlobal || matchLocal) {
                // Find start character
                // Find start character
                const matchIndex = line.indexOf(name);
                if (matchIndex >= 0) {
                    return new vscode.Location(
                        uri,
                        new vscode.Range(i, matchIndex, i, matchIndex + name.length)
                    );
                }
            }
        }
        
        return undefined;
    }
}

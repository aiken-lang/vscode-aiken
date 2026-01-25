import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

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
            return definitions;
        }

        // 2. Check imports
        const importedDef = await this.findImportedDefinition(document, word);
        if (importedDef) {
            definitions.push(importedDef);
            return definitions;
        }

        return undefined;
    }

    private findDefinitionInText(text: string, name: string, uri: vscode.Uri): vscode.Location | undefined {
        const lines = text.split('\n');
        // Match definitions: type Name, pub type Name, fn name, validator name, let name, expect name
        const regex = new RegExp(`^\\s*(pub\\s+)?(type|fn|validator|opaque\\s+type|let|expect)\\s+${name}\\b`);
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.trim().startsWith('//')) continue;
            
            if (regex.test(line)) {
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

    private async findImportedDefinition(document: vscode.TextDocument, name: string): Promise<vscode.Location | undefined> {
        const text = document.getText();
        const lines = text.split('\n');
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) return undefined;

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (!line.startsWith('use ')) continue;

            let currentImport = line;
            let openBraces = (currentImport.match(/{/g) || []).length;
            let closeBraces = (currentImport.match(/}/g) || []).length;

            while (openBraces > closeBraces && i + 1 < lines.length) {
                i++;
                const nextLine = lines[i].trim();
                currentImport += ' ' + nextLine;
                openBraces += (nextLine.match(/{/g) || []).length;
                closeBraces += (nextLine.match(/}/g) || []).length;
            }

            const useParts = currentImport.substring(4).split('.'); // remove 'use '
            
            if (useParts.length === 1) {
                const modulePath = useParts[0].trim();
                const moduleName = modulePath.split('/').pop();

                if (moduleName === name) {
                     // TODO: Handle module alias definition if needed
                }
            } else if (useParts.length >= 2) {
                 const braceStart = currentImport.indexOf('{');
                 if (braceStart !== -1) {
                     const modulePath = currentImport.substring(4, braceStart).replace(/\.$/, '').trim(); 
                     const symbolsPart = currentImport.substring(braceStart);
                     
                     if (symbolsPart.startsWith('{') && symbolsPart.endsWith('}')) {
                         const content = symbolsPart.slice(1, -1);
                         const imports = content.split(',').map(s => s.trim());
                         
                         if (imports.includes(name)) {
                             return await this.resolveModuleDefinition(workspaceFolder.uri.fsPath, modulePath, name);
                         }
                     }
                 } else {
                     const lastDot = currentImport.lastIndexOf('.');
                     const modulePath = currentImport.substring(4, lastDot).trim();
                     const symbol = currentImport.substring(lastDot + 1).trim();
                     if (symbol === name) {
                         return await this.resolveModuleDefinition(workspaceFolder.uri.fsPath, modulePath, name);
                     }
                 }
            }
        }
        return undefined;
    }

    private async resolveModuleDefinition(rootPath: string, modulePath: string, formattedName: string): Promise<vscode.Location | undefined> {
         const possiblePaths = [
             path.join(rootPath, 'lib', `${modulePath}.ak`),
             path.join(rootPath, 'validators', `${modulePath}.ak`),
         ];

         const buildDir = path.join(rootPath, 'build', 'packages');

         if (fs.existsSync(buildDir)) {
             try {
                const packages = fs.readdirSync(buildDir);
                for (const pkg of packages) {
                    possiblePaths.push(path.join(buildDir, pkg, 'lib', `${modulePath}.ak`));
                }
             } catch (e) {
                 console.error("Error reading packages", e);
             }
         }

         for (const fullPath of possiblePaths) {
             if (fs.existsSync(fullPath)) {
                 const fileContent = fs.readFileSync(fullPath, 'utf8');
                 // Simply reuse findDefinitionInText logic but for the filtered regex
                 const lines = fileContent.split('\n');
                  const regex = new RegExp(`^\\s*(pub\\s+)?(type|fn|validator|opaque\\s+type)\\s+${formattedName}\\b`);
                 
                 for (let i = 0; i < lines.length; i++) {
                     const line = lines[i];
                     if (line.trim().startsWith('//')) continue;
                     
                     if (regex.test(line)) {
                         const matchIndex = line.indexOf(formattedName);
                         if (matchIndex >= 0) {
                             return new vscode.Location(
                                 vscode.Uri.file(fullPath),
                                 new vscode.Range(i, matchIndex, i, matchIndex + formattedName.length)
                             );
                         }
                     }
                 }
             }
         }

         return undefined;
    }
}

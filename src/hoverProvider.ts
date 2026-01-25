import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class AikenHoverProvider implements vscode.HoverProvider {
    public async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) return;

        const word = document.getText(wordRange);
        console.log(">>> / hoverProvider.ts:15 / word:", word);

        
        // 1. Check local definitions first
        const localDef = this.findDefinitionInText(document.getText(), word);
        if (localDef) {
            const contents: (vscode.MarkdownString | string)[] = [];
            if (localDef.docs) {
                contents.push(new vscode.MarkdownString(localDef.docs));
            }
            contents.push(new vscode.MarkdownString().appendCodeblock(localDef.code, 'aiken'));
            return new vscode.Hover(contents);
        }

        // 2. Check imports
        const importedDef = await this.findImportedDefinition(document, word);
        if (importedDef) {
            const contents: (vscode.MarkdownString | string)[] = [];
            if (importedDef.docs) {
                contents.push(new vscode.MarkdownString(importedDef.docs));
            }
            contents.push(new vscode.MarkdownString().appendCodeblock(importedDef.code, 'aiken'));
            return new vscode.Hover(contents);
        }

        return undefined;
    }

    private findDefinitionInText(text: string, name: string): { docs: string, code: string } | undefined {
        const lines = text.split('\n');
        // Match definitions: type Name, pub type Name, fn name, validator name, let name, expect name
        const regex = new RegExp(`^\\s*(pub\\s+)?(type|fn|validator|opaque\\s+type|let|expect)\\s+${name}\\b`);
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.trim().startsWith('//') && !line.trim().startsWith('///')) continue;

            if (regex.test(line)) {
                return this.extractDefinitionWithDocs(lines, i);
            }
        }
        return undefined;
    }

    private async findImportedDefinition(document: vscode.TextDocument, name: string): Promise<{ docs: string, code: string } | undefined> {
        const text = document.getText();
        const lines = text.split('\n');
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) return undefined;

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (!line.startsWith('use ')) continue;

            let currentImport = line;
            // Handle multi-line imports: if it opens a brace but doesn't close it
            let openBraces = (currentImport.match(/{/g) || []).length;
            let closeBraces = (currentImport.match(/}/g) || []).length;

            while (openBraces > closeBraces && i + 1 < lines.length) {
                i++;
                const nextLine = lines[i].trim();
                // Skip comments if interspersed? Aiken format usually puts them on separate lines or inline. 
                // We'll just concatenate for parsing purposes.
                currentImport += ' ' + nextLine;
                openBraces += (nextLine.match(/{/g) || []).length;
                closeBraces += (nextLine.match(/}/g) || []).length;
            }

            const useParts = currentImport.substring(4).split('.'); // remove 'use '
            
            if (useParts.length === 1) {
                // Case: use path/to/module
                // The module name is the last part of the path
                const modulePath = useParts[0].trim();
                const moduleName = modulePath.split('/').pop();

                if (moduleName === name) {
                    // Hovering over the module alias itself? 
                    // Or maybe user is using Module.function?
                    // For now, let's focus on symbols imported via braces.
                    // If the user uses `module.Symbol`, we might want to handle that too, but let's stick to the request.
                }
            } else if (useParts.length >= 2) {
                 // It might be `use cardano/transaction.{ ... }`
                 // Re-join just in case split('.') broke something inside braces (unlikely for valid syntax but safe)
                 // Actually parsing `path.to.module.{A,B}` is better done by regex.
                 
                 const braceStart = currentImport.indexOf('{');
                 if (braceStart !== -1) {
                     const modulePath = currentImport.substring(4, braceStart).replace(/\.$/, '').trim(); // 'cardano/transaction'
                     const symbolsPart = currentImport.substring(braceStart); // '{A, B, C}'
                     
                     if (symbolsPart.startsWith('{') && symbolsPart.endsWith('}')) {
                         const content = symbolsPart.slice(1, -1);
                         const imports = content.split(',').map(s => s.trim());
                         
                         if (imports.includes(name)) {
                             // Found it! It's imported from modulePath
                             return await this.resolveModuleDefinition(workspaceFolder.uri.fsPath, modulePath, name);
                         }
                     }
                 } else {
                     // Case: use path/to/module.Symbol
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

    private async resolveModuleDefinition(rootPath: string, modulePath: string, formattedName: string): Promise<{ docs: string, code: string } | undefined> {
         // Construct full file path. 
         // Strategy:
         // 1. Check local lib/
         // 2. Check build/packages/*/lib/

         // modulePath is like "cardano/address"
         
         const possiblePaths = [
             path.join(rootPath, 'lib', `${modulePath}.ak`),
             path.join(rootPath, 'validators', `${modulePath}.ak`),
             // We need to glob/scan build packages because we don't know the package name explicitly from the import
             // But we can guess standard ones or search.
         ];

         // Add standard lib paths
         // We construct a search for "build/packages/*/lib/modulePath.ak"
         // scanning directory manually since glob might be slow or extra dep.
         
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
                 // For imported files, we also use extractDefinitionWithDocs finding lines first
                 const lines = fileContent.split('\n');
                 const regex = new RegExp(`^\\s*(pub\\s+)?(type|fn|validator|opaque\\s+type)\\s+${formattedName}\\b`);
                 for (let i = 0; i < lines.length; i++) {
                     if (regex.test(lines[i])) {
                         return this.extractDefinitionWithDocs(lines, i);
                     }
                 }
             }
         }

         return undefined;
    }

    private extractDefinitionWithDocs(lines: string[], definitionIndex: number): { docs: string, code: string } {
        // 1. Extract docs (look backwards)
        const docLines = [];
        let j = definitionIndex - 1;
        while (j >= 0) {
            const prevLine = lines[j].trim();
            if (prevLine.startsWith('///')) {
                // Remove '///' and leading space
                docLines.unshift(prevLine.substring(3).trimStart());
            } else if (prevLine.startsWith('//')) {
                 // Regular comments might not be docs, but let's include if immediately adjacent?
                 // Stdlib uses /// for docs.
                 // If it's empty, maybe a spacer.
                 if (prevLine === '') {
                     // potential break if empty line between docs and def?
                     // usually docs are attached.
                 } else {
                     // break on non-comment
                     break; 
                 }
            } else {
                 // break
                 break;
            }
            j--;
        }

        // 2. Extract code block and strip internal comments
        const codeBlock = this.extractDefinitionBlock(lines, definitionIndex);
        
        return {
            docs: docLines.join('\n'),
            code: codeBlock
        };
    }

    private extractDefinitionBlock(lines: string[], startIndex: number): string {
        const startLine = lines[startIndex];
        if (startLine.trim().endsWith('{')) {
            let extracted: string[] = [];
            let openBraces = 0;
            
            // Re-scan start line to handle cases like `pub type Foo {` correctly if we start loop from it
            // actually logic below handles line j=startIndex.
            
            for (let j = startIndex; j < lines.length; j++) {
                const line = lines[j];
                const trimmed = line.trim();

                // Skip documentation comments inside the block
                if (trimmed.startsWith('///')) continue;
                // Maybe skip regular comments too? The user request specifically mentioned `///` ones inside `pub type`.
                // "fix: show comment as description detail like typescript"
                // The provided example had `/// > [!IMPORTANT]` inside fields.
                // Assuming we want to strip all `///` lines from the code view.
                
                extracted.push(line);
                
                openBraces += (line.match(/{/g) || []).length;
                openBraces -= (line.match(/}/g) || []).length;
                
                if (openBraces <= 0 && j >= startIndex) break; // j>=startIndex ensures we processed at least one line (the start line)
                if (extracted.length >= 200) break; // Safety limit
            }
            return extracted.join('\n');
        } else {
            // function signature might span multiple lines if args are broken up
            // naive approach: take lines until we see '->' and return type, or '{' or just few lines.
            // For simple types/functions, 1-3 lines is usually enough if not a block.
            return lines.slice(startIndex, Math.min(startIndex + 5, lines.length)).join('\n');
        }
    }
}

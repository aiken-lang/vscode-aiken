import * as vscode from 'vscode';

export class AikenHoverProvider implements vscode.HoverProvider {
    public async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) return;

        const word = document.getText(wordRange);
        
        // 1. Check current document for definition line
        const defLine = this.findDefinitionLine(document.getText(), word);

        if (defLine) {
            // Create a markdown block for the signature
            const md = new vscode.MarkdownString();
            md.appendCodeblock(defLine.trim(), 'aiken');
            return new vscode.Hover(md);
        }

        return undefined;
    }

    private findDefinitionLine(text: string, name: string): string | undefined {
        const lines = text.split('\n');
        
        // Match 'let', 'expect', 'validator', 'type', and 'pub type'
        const regex = new RegExp(`\\b(let|expect|validator|type|pub\\s+type)\\s+${name}\\b`);
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Skip comment lines
            if (line.trim().startsWith('//')) continue;

            if (regex.test(line)) {
                // Check if it's a block definition (ends with '{')
                if (line.trim().endsWith('{')) {
                    let extracted = [line];
                    let openBraces = 1;
                    
                    // Read subsequent lines to capture the full block
                    for (let j = i + 1; j < lines.length; j++) {
                        const nextLine = lines[j];
                        extracted.push(nextLine);
                        
                        // Count braces to find the closing one
                        openBraces += (nextLine.match(/{/g) || []).length;
                        openBraces -= (nextLine.match(/}/g) || []).length;
                        
                        if (openBraces <= 0) break;
                        if (extracted.length >= 30) break; // Safety limit
                    }
                    return extracted.join('\n');
                } else {
                    // For single-line definitions or non-block constructs, return up to 3 lines
                    const endLine = Math.min(i + 3, lines.length);
                    return lines.slice(i, endLine).join('\n');
                }
            }
        }
        return undefined;
    }
}

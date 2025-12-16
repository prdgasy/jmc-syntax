// src/providers.js
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { getGlobalScope, getSignatureFromSnippet, getParamsFromSignature, extractVariables, parseFunctionsAndClasses } = require('./jmcParser');
const { mcCommandDocs, nbtTypes } = require('./constants');

// Fonction pour lister les fichiers JMC récursivement
function findJmcFiles(dir, rootPath) {
    let results = [];
    try {
        for (const file of fs.readdirSync(dir)) {
            if (file === 'node_modules' || file.startsWith('.')) continue;
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) results = results.concat(findJmcFiles(fullPath, rootPath));
            else if (file.endsWith('.jmc')) results.push(path.relative(rootPath, fullPath).replace(/\\/g, '/'));
        }
    } catch { }
    return results;
}

// Fonction utilitaire locale pour les variables (utilisée par variableCompletionProvider)
function getImportedFiles(document) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) return [];
    const text = document.getText();
    const importRegex = /^\s*import\s+"([^"]+)"/gm;
    const importedFiles = new Set();
    let match;
    while ((match = importRegex.exec(text)) !== null) {
        let importPath = match[1];
        if (!importPath.endsWith('.jmc') && !importPath.includes('*')) importPath += '.jmc';
        const fullPath = path.resolve(path.dirname(document.uri.fsPath), importPath);
        if (fs.existsSync(fullPath)) importedFiles.add(fullPath);
    }
    importedFiles.add(path.resolve(document.uri.fsPath));
    return [...importedFiles];
}

// Fonction pour deviner le type NBT
function inferNbtType(value) {
    value = value.trim();
    if (value.startsWith('"') || value.startsWith("'") || value.startsWith('`')) return nbtTypes.string;
    if (value.startsWith('{')) return nbtTypes.compound;
    if (value.startsWith('[')) return nbtTypes.list;
    if (value === 'true' || value === 'false') return nbtTypes.byte;
    if (/^-?\d+[bB]$/.test(value)) return nbtTypes.byte;
    if (/^-?\d+[sS]$/.test(value)) return nbtTypes.short || "Short";
    if (/^-?\d+[lL]$/.test(value)) return nbtTypes.long;
    if (/^-?\d+[fF]$/.test(value) || /^-?\d+\.\d+[fF]?$/.test(value)) return nbtTypes.float;
    if (/^-?\d+[dD]$/.test(value) || /^-?\d+\.\d+[dD]?$/.test(value)) return nbtTypes.double;
    if (/^-?\d+$/.test(value)) return nbtTypes.integer;
    return "Any";
}

function initProviders(context, snippets) {

    // --- 1. Autocompletion IMPORTS ---
    const importCompletionProvider = vscode.languages.registerCompletionItemProvider('jmc', {
        async provideCompletionItems(document, position) {
            const linePrefix = document.lineAt(position).text.substring(0, position.character);
            if (!linePrefix.endsWith('import "')) return undefined;

            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (!workspaceFolder) return [];

            const rootPath = workspaceFolder.uri.fsPath;
            const currentFile = path.relative(rootPath, document.uri.fsPath).replace(/\\/g, '/');
            const allFiles = findJmcFiles(rootPath, rootPath);
            const suggestions = allFiles.filter(f => f !== currentFile);

            return suggestions.map(f => new vscode.CompletionItem(f.slice(0, -4), vscode.CompletionItemKind.File));
        }
    }, '"');

    // --- 2. Autocompletion GENERALE (Commandes, Snippets, Fonctions Utilisateur) ---
    const snippetCompletionProvider = vscode.languages.registerCompletionItemProvider('jmc', {
        provideCompletionItems(document, position) {
            const items = [];
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

            // A. Fonctions JMC (Snippets Built-in)
            Object.entries(snippets).forEach(([label, snippet]) => {
                const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Function);
                item.insertText = new vscode.SnippetString(snippet.body.join('\n'));
                const signature = getSignatureFromSnippet(snippet.body);
                const doc = new vscode.MarkdownString();
                doc.appendCodeblock(signature, 'jmc');
                if (snippet.description) doc.appendMarkdown(`\n\n${snippet.description}`);
                item.documentation = doc;
                item.detail = '(JMC Built-in)';
                items.push(item);
            });

            // B. Commandes Minecraft (Vanilla)
            Object.entries(mcCommandDocs).forEach(([cmd, info]) => {
                const item = new vscode.CompletionItem(cmd, vscode.CompletionItemKind.Keyword);
                item.insertText = cmd + " ";
                const doc = new vscode.MarkdownString();
                doc.appendCodeblock(info.syntax, 'mcfunction');
                doc.appendMarkdown(`\n\n${info.description}`);
                item.documentation = doc;
                item.detail = '(Minecraft Command)';
                items.push(item);
            });

            // C. Fonctions & Classes Utilisateur (Global Scope)
            if (workspaceFolder) {
                const scope = getGlobalScope(workspaceFolder.uri.fsPath, document);
                scope.functions.forEach((info, name) => {
                    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
                    const relPath = vscode.workspace.asRelativePath(info.filePath);
                    item.detail = `User Function (${relPath})`;
                    item.documentation = new vscode.MarkdownString(`Defined in **${relPath}** at line ${info.line + 1}`);
                    items.push(item);
                });
                scope.classes.forEach((info, name) => {
                    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
                    const relPath = vscode.workspace.asRelativePath(info.filePath);
                    item.detail = `User Class (${relPath})`;
                    items.push(item);
                });
            }
            return items;
        }
    });

    // --- 3. Signature Help ---
    const signatureProvider = vscode.languages.registerSignatureHelpProvider('jmc', {
        provideSignatureHelp(document, position) {
            const line = document.lineAt(position).text.substring(0, position.character);
            const match = line.match(/(\b[a-zA-Z_][\w.]*)\s*\(([^)]*)$/);
            if (!match) return null;

            const fnName = match[1];
            const paramsEntered = match[2];
            const snippet = snippets[fnName];
            if (!snippet) return null;

            const signatureLabel = getSignatureFromSnippet(snippet.body);
            const params = getParamsFromSignature(signatureLabel);
            const sigInfo = new vscode.SignatureInformation(signatureLabel, new vscode.MarkdownString(snippet.description));
            sigInfo.parameters = params.map(p => new vscode.ParameterInformation(p));

            const help = new vscode.SignatureHelp();
            help.signatures = [sigInfo];
            help.activeSignature = 0;
            help.activeParameter = Math.min((paramsEntered.match(/,/g) || []).length, params.length - 1);
            return help;
        }
    }, '(', ',');

    // --- 4. Hover Provider ---
    const hoverProvider = vscode.languages.registerHoverProvider('jmc', {
        provideHover(document, position) {
            const range = document.getWordRangeAtPosition(position, /[@~^A-Za-z0-9_.:$]+/);
            if (!range) return;

            const word = document.getText(range);
            const lineText = document.lineAt(position.line).text;

            // A. Clé NBT
            const keyRegex = new RegExp(`\\b${word}\\s*:\\s*(.*)`);
            const keyMatch = keyRegex.exec(lineText);
            if (keyMatch && !word.startsWith('$') && !word.includes('::')) {
                let valuePart = keyMatch[1].trim();
                // Gestion multiligne basique
                if ((valuePart === '' || valuePart === '{' || valuePart === '[') && position.line + 1 < document.lineCount) {
                    const nextLine = document.lineAt(position.line + 1).text.trim();
                    if (lineText.trim().endsWith('{') || nextLine.startsWith('{')) valuePart = '{';
                    else if (lineText.trim().endsWith('[') || nextLine.startsWith('[')) valuePart = '[';
                }
                if (valuePart.endsWith(',')) valuePart = valuePart.slice(0, -1);
                const type = inferNbtType(valuePart);
                const md = new vscode.MarkdownString();
                md.appendCodeblock(`${word}: ${type}`, 'jmc');
                return new vscode.Hover(md, range);
            }

            // B. Variables
            if (word.startsWith('$') || word.includes('::')) {
                const markdown = new vscode.MarkdownString();
                if (word.startsWith('$')) {
                    markdown.appendCodeblock(`score ${word}: Int`, 'jmc');
                    markdown.appendMarkdown('\n\nJMC Variable (Scoreboard Integer)');
                } else if (word.includes('::')) {
                    const text = document.getText();
                    const escapedWord = word.replace(/\./g, '\\.');
                    const assignRegex = new RegExp(`${escapedWord}\\s*=\\s*([^;]+)`, 'm');
                    const match = assignRegex.exec(text);
                    let type = "Unknown";
                    if (match) {
                        let valStart = match[1].trim();
                        if (valStart.startsWith('{')) valStart = '{';
                        else if (valStart.startsWith('[')) valStart = '[';
                        else valStart = valStart.split(/[,\s]/)[0];
                        type = inferNbtType(valStart);
                    }
                    markdown.appendCodeblock(`storage ${word}: ${type}`, 'jmc');
                    markdown.appendMarkdown('\n\nJMC Storage Variable');
                }
                return new vscode.Hover(markdown, range);
            }

            // C. Commandes Minecraft
            if (mcCommandDocs[word]) {
                const cmdInfo = mcCommandDocs[word];
                const md = new vscode.MarkdownString();
                md.appendCodeblock(cmdInfo.syntax, 'mcfunction');
                md.appendMarkdown(`\n\n**Description:** ${cmdInfo.description}`);
                return new vscode.Hover(md, range);
            }

            // D. Built-in Snippets
            const snippet = snippets[word];
            if (snippet) {
                const signature = getSignatureFromSnippet(snippet.body);
                const md = new vscode.MarkdownString();
                md.appendCodeblock(signature, 'jmc');
                if (snippet.description) md.appendMarkdown(`\n\n${snippet.description}`);
                return new vscode.Hover(md, range);
            }

            // E. Fonctions Utilisateur
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (workspaceFolder) {
                const scope = getGlobalScope(workspaceFolder.uri.fsPath, document);
                if (scope.functions.has(word)) {
                    const info = scope.functions.get(word);
                    const relPath = vscode.workspace.asRelativePath(info.filePath);
                    const md = new vscode.MarkdownString();
                    md.appendCodeblock(`function ${word}()`, 'jmc');
                    md.appendMarkdown(`\n\nUser defined function in **${relPath}** at line ${info.line + 1}`);
                    return new vscode.Hover(md, range);
                }
                if (scope.classes.has(word)) {
                    const info = scope.classes.get(word);
                    const relPath = vscode.workspace.asRelativePath(info.filePath);
                    const md = new vscode.MarkdownString();
                    md.appendCodeblock(`class ${word}`, 'jmc');
                    md.appendMarkdown(`\n\nUser class defined in **${relPath}**`);
                    return new vscode.Hover(md, range);
                }
            }
        }
    });

    // --- 5. Definition Provider ---
    const definitionProvider = vscode.languages.registerDefinitionProvider('jmc', {
        async provideDefinition(document, position) {
            const line = document.lineAt(position.line);
            const importMatch = line.text.match(/import\s+"([^"]+)"/);

            // A. Import Definition
            if (importMatch) {
                const relativePath = importMatch[1];
                const quoteIndex = line.text.indexOf(`"${relativePath}"`);
                const importRange = new vscode.Range(line.lineNumber, quoteIndex + 1, line.lineNumber, quoteIndex + 1 + relativePath.length);
                if (importRange.contains(position)) {
                    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
                    if (!workspaceFolder) return null;
                    const currentDir = path.dirname(document.uri.fsPath);
                    let targetPath = relativePath;
                    if (!targetPath.endsWith('.jmc') && !targetPath.endsWith('*')) targetPath += '.jmc';
                    let absPath = path.resolve(currentDir, targetPath);
                    if (!fs.existsSync(absPath)) absPath = path.resolve(workspaceFolder.uri.fsPath, targetPath);
                    if (fs.existsSync(absPath)) return new vscode.Location(vscode.Uri.file(absPath), new vscode.Position(0, 0));
                }
            }

            // B. Function/Class Definition
            const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_.]+/);
            if (!wordRange) return null;
            const word = document.getText(wordRange);
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (workspaceFolder) {
                const scope = getGlobalScope(workspaceFolder.uri.fsPath, document);
                if (scope.functions.has(word)) {
                    const info = scope.functions.get(word);
                    return new vscode.Location(vscode.Uri.file(info.filePath), new vscode.Position(info.line, 0));
                }
                if (scope.classes.has(word)) {
                    const info = scope.classes.get(word);
                    return new vscode.Location(vscode.Uri.file(info.filePath), new vscode.Position(info.line, 0));
                }
            }
            return null;
        }
    });

    // --- 6. Variables/Storage Completion ---
    const variableCompletionProvider = vscode.languages.registerCompletionItemProvider('jmc', {
        provideCompletionItems(document) {
            const variables = new Set();
            const importedFiles = getImportedFiles(document);
            for (const filePath of importedFiles) {
                const content = fs.readFileSync(filePath, 'utf8');
                const { normal } = extractVariables(content);
                for (const v of normal) variables.add(v);
            }
            return [...variables].map(v => new vscode.CompletionItem(v, vscode.CompletionItemKind.Variable));
        }
    }, '$');

    const storageCompletionProvider = vscode.languages.registerCompletionItemProvider('jmc', {
        provideCompletionItems(document) {
            const storages = new Set();
            const importedFiles = getImportedFiles(document);
            for (const filePath of importedFiles) {
                const content = fs.readFileSync(filePath, 'utf8');
                const { storage } = extractVariables(content);
                for (const s of storage) storages.add(s);
            }
            return [...storages].map(v => new vscode.CompletionItem(v, vscode.CompletionItemKind.Variable));
        }
    }, ':');

    return [
        snippetCompletionProvider,
        hoverProvider,
        signatureProvider,
        variableCompletionProvider,
        storageCompletionProvider,
        definitionProvider,
        importCompletionProvider
    ];
}

module.exports = { initProviders };
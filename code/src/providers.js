const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { parseParams, paramType, extractVariables, parseFunctionsAndClasses } = require('./jmcParser');
const { mcCommandDocs, nbtTypes } = require('./constants');
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

function getImportedFiles(document) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const rootPath = workspaceFolder?.uri.fsPath;
    if (!rootPath) return [];

    const text = document.getText();
    const importRegex = /^\s*import\s+"([^"]+)"/gm;
    const importedFiles = new Set();

    let match;

    while ((match = importRegex.exec(text)) !== null) {
        const importPath = match[1];

        // Cas import de type dossier avec "*"
        if (importPath.endsWith('/*')) {
            // chemin du dossier à partir de rootPath + chemin relatif
            const folderRelative = importPath.slice(0, -2); // enlever "/*"
            const folderFullPath = path.resolve(rootPath, folderRelative);

            if (fs.existsSync(folderFullPath) && fs.statSync(folderFullPath).isDirectory()) {
                const files = fs.readdirSync(folderFullPath);
                for (const f of files) {
                    if (f.endsWith('.jmc')) {
                        importedFiles.add(path.resolve(folderFullPath, f));
                    }
                }
            }
        }
        else if (importPath === '*') {
            // importer tous les fichiers .jmc à la racine (rootPath)
            const files = fs.readdirSync(rootPath);
            for (const f of files) {
                if (f.endsWith('.jmc')) {
                    importedFiles.add(path.resolve(rootPath, f));
                }
            }
        }
        else {
            // import simple fichier .jmc
            let filePath = importPath;
            if (!filePath.endsWith('.jmc')) {
                filePath += '.jmc';
            }
            const fullPath = path.resolve(rootPath, filePath);
            if (fs.existsSync(fullPath)) {
                importedFiles.add(fullPath);
            }
        }
    }

    // Toujours inclure le fichier courant
    importedFiles.add(path.resolve(document.uri.fsPath));

    return [...importedFiles];
}


function inferNbtType(value) {
    value = value.trim();
    if (value.startsWith('"') || value.startsWith("'") || value.startsWith('`')) return nbtTypes.string;
    if (value === 'true' || value === 'false') return nbtTypes.byte;
    if (value.startsWith('{')) return nbtTypes.compound;
    if (value.startsWith('[')) return nbtTypes.list;
    if (/^-?\d+\.\d+[dD]?$/.test(value)) return nbtTypes.double;
    if (/^-?\d+[fF]$/.test(value) || /^-?\d+\.\d+[fF]?$/.test(value)) return nbtTypes.float;
    if (/^-?\d+[bB]$/.test(value)) return nbtTypes.byte;
    if (/^-?\d+[lL]$/.test(value)) return nbtTypes.long;
    if (/^-?\d+$/.test(value)) return nbtTypes.integer;
    return "Any";
}

function initProviders(context, snippets) {
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

    const snippetCompletionProvider = vscode.languages.registerCompletionItemProvider('jmc', {
        provideCompletionItems() {
            const items = [];

            // A. Fonctions JMC (Snippets)
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

            return items;
        }
    });

    const signatureProvider = vscode.languages.registerSignatureHelpProvider('jmc', {
        provideSignatureHelp(document, position) {
            const line = document.lineAt(position).text.substring(0, position.character);
            const match = line.match(/(\b[a-zA-Z_][\w.]*)\s*\(([^)]*)$/);
            if (!match) return null;

            const fnName = match[1];
            const paramsEntered = match[2];
            const snippet = snippets[fnName];
            if (!snippet) return null;

            const params = parseParams(snippet.body);

            // SignatureInfo
            const label = `function ${fnName}(${params.join(', ')})`;
            const sigInfo = new vscode.SignatureInformation(label, new vscode.MarkdownString()
                .appendCodeblock(label, 'jmc')
                .appendMarkdown(`\n\n${snippet.description || 'No documentation available.'}`));

            // Parameters
            sigInfo.parameters = params.map(p =>
                new vscode.ParameterInformation(p, new vscode.MarkdownString(`\`${p}\`: ${paramType(p)}`))
            );

            // SignatureHelp object
            const help = new vscode.SignatureHelp();
            help.signatures = [sigInfo];
            help.activeSignature = 0;
            help.activeParameter = Math.min((paramsEntered.match(/,/g) || []).length, params.length - 1);

            return help;
        }
    }, '(', ',');

    // MULTIFICHIER
    const hoverProvider = vscode.languages.registerHoverProvider('jmc', {
        provideHover(document, position) {
            const range = document.getWordRangeAtPosition(position, /[@~^A-Za-z0-9_.:$]+/);
            if (!range) return;

            const word = document.getText(range);
            const lineText = document.lineAt(position.line).text;

            // A. Hover sur une clé de structure (ex: data: '0')
            // Regex pour capturer "mot_clé :" suivi d'une valeur, sur la même ligne ou lignes suivantes (approximatif pour le hover)
            const keyRegex = new RegExp(`\\b${word}\\s*:\\s*(.*)`);
            const keyMatch = keyRegex.exec(lineText);

            if (keyMatch && !word.startsWith('$') && !word.includes('::')) {
                // C'est une clé d'objet, on essaie de deviner le type de la valeur
                let valuePart = keyMatch[1].trim();
                // Si la valeur est vide (sur la ligne suivante), on regarde un peu après (simplifié)
                if ((valuePart === '' || valuePart === '{' || valuePart === '[') && position.line + 1 < document.lineCount) {
                    // Si c'est un début de bloc, on assume compound/list
                    if (lineText.includes('{')) valuePart = '{';
                    else if (lineText.includes('[')) valuePart = '[';
                }

                // On retire la virgule finale si présente
                if (valuePart.endsWith(',')) valuePart = valuePart.slice(0, -1);

                const type = inferNbtType(valuePart);
                const md = new vscode.MarkdownString();
                md.appendCodeblock(`${word}: ${type}`, 'jmc');
                return new vscode.Hover(md, range);
            }

            // B. Variables
            if (word.startsWith('$') || word.includes('::')) {
                const markdown = new vscode.MarkdownString();
                markdown.appendCodeblock(`var ${word}: ${word.startsWith('$') ? 'score' : 'storage'}`, 'jmc');
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

            // D. Fonctions JMC & User Functions (Inchangé)
            // ... (Copiez votre code existant pour les snippets et user functions ici) ...

            // Built-in functions (Snippets)
            const snippet = snippets[word];
            if (snippet) {
                const signature = getSignatureFromSnippet(snippet.body);
                const md = new vscode.MarkdownString();
                md.appendCodeblock(signature, 'jmc');
                if (snippet.description) {
                    md.appendMarkdown(`\n\n${snippet.description}`);
                }
                return new vscode.Hover(md, range);
            }

            // User defined functions (Multi-files)
            // (Code existant pour getImportedFiles et parsing...)
        }
    });

    const variableCompletionProvider = vscode.languages.registerCompletionItemProvider('jmc', {
        provideCompletionItems(document) {
            const variables = new Set();
            const importedFiles = getImportedFiles(document);
            if (!importedFiles.length) return [];

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
            if (!importedFiles.length) return [];

            for (const filePath of importedFiles) {
                const content = fs.readFileSync(filePath, 'utf8');
                const { storage } = extractVariables(content);
                for (const s of storage) storages.add(s);
            }

            return [...storages].map(v => new vscode.CompletionItem(v, vscode.CompletionItemKind.Variable));
        }
    }, ':');

    const functionCompletionProvider = vscode.languages.registerCompletionItemProvider('jmc', {
        provideCompletionItems(document) {
            const items = [];
            const classSet = new Set();
            const importedFiles = getImportedFiles(document);
            if (!importedFiles.length) return [];

            for (const filePath of importedFiles) {
                const content = fs.readFileSync(filePath, 'utf8');
                const { classMap, functionMap } = parseFunctionsAndClasses(content);

                for (const className of classMap.keys()) {
                    if (!classSet.has(className)) {
                        classSet.add(className);
                        items.push(new vscode.CompletionItem(className, vscode.CompletionItemKind.Class));
                    }
                }

                for (const [fnName] of functionMap.entries()) {
                    items.push(new vscode.CompletionItem(fnName, vscode.CompletionItemKind.Function));
                }
            }

            return items;
        }
    });

    const definitionProvider = vscode.languages.registerDefinitionProvider('jmc', {
        async provideDefinition(document, position) {
            const line = document.lineAt(position.line);
            const importMatch = line.text.match(/import\s+"([^"]+)"/);
            if (importMatch) {
                const relativePath = importMatch[1];
                const quoteIndex = line.text.indexOf(`"${relativePath}"`);
                const importRange = new vscode.Range(line.lineNumber, quoteIndex + 1, line.lineNumber, quoteIndex + 1 + relativePath.length);
                if (importRange.contains(position)) {
                    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
                    if (!workspaceFolder) return null;

                    const targetPath = path.join(workspaceFolder.uri.fsPath, relativePath + '.jmc');
                    if (fs.existsSync(targetPath)) {
                        return new vscode.Location(vscode.Uri.file(targetPath), new vscode.Position(0, 0));
                    }
                }
            }

            const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_.]+/);
            if (!wordRange) return null;

            const word = document.getText(wordRange);
            const text = document.getText();

            const offset = document.offsetAt(wordRange.start);
            if (/function\s*$/.test(text.slice(Math.max(0, offset - 10), offset))) {
                const usageRegex = new RegExp(`\\b${word}\\s*\\(`, 'g');
                const locations = [];
                let match;
                while ((match = usageRegex.exec(text)) !== null) {
                    if (/function\s*$/.test(text.slice(Math.max(0, match.index - 10), match.index))) continue;
                    const startPos = document.positionAt(match.index);
                    locations.push(new vscode.Location(document.uri, new vscode.Range(startPos, startPos.translate(0, word.length))));
                }
                if (locations.length) vscode.commands.executeCommand('editor.action.showReferences', document.uri, position, locations);
                else vscode.window.showInformationMessage(`No usages found for function '${word}'.`);
                return null;
            }

            const defRegex = new RegExp(`function\\s+(?:[\\w.]*\\.)?${word}\\b`);
            const defMatch = defRegex.exec(text);
            if (defMatch) {
                const pos = document.positionAt(defMatch.index + defMatch[0].lastIndexOf(word));
                return new vscode.Location(document.uri, pos);
            }

            return null;
        }
    });

    return [
        snippetCompletionProvider,
        hoverProvider,
        signatureProvider,
        variableCompletionProvider,
        storageCompletionProvider,
        functionCompletionProvider,
        definitionProvider,
        importCompletionProvider
    ];
}

module.exports = { initProviders };

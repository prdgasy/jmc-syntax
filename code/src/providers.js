const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { getGlobalScope, getSignatureFromSnippet, getParamsFromSignature, extractVariables } = require('./jmcParser');
const { mcCommandDocs, nbtTypes, hjmcDirectives } = require('./constants');

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

function inferNbtType(value) {
    value = value.trim();
    if (value.startsWith('"') || value.startsWith("'") || value.startsWith('`')) return nbtTypes.string;
    if (value.startsWith('{')) return nbtTypes.compound;
    if (value.startsWith('[')) return nbtTypes.list;
    if (value === 'true' || value === 'false') return nbtTypes.byte;

    // Regex améliorées pour supporter les nombres avec points et suffixes
    if (/^-?\d*(\.\d+)?[fF]$/.test(value)) return nbtTypes.float;
    if (/^-?\d*(\.\d+)?[dD]$/.test(value)) return nbtTypes.double;
    if (/^-?\d*(\.\d+)?[bB]$/.test(value)) return nbtTypes.byte; // Supporte 0.1b pour le hover
    if (/^-?\d+[lL]$/.test(value)) return nbtTypes.long;
    if (/^-?\d+[sS]$/.test(value)) return nbtTypes.short;
    if (/^-?\d+\.\d+$/.test(value)) return nbtTypes.double;
    if (/^-?\d+$/.test(value)) return nbtTypes.integer;

    return "Any";
}

function initProviders(context, snippets) {

    // --- 1. Autocompletion IMPORTS ---
    const importCompletionProvider = vscode.languages.registerCompletionItemProvider('jmc', {
        async provideCompletionItems(document, position) {
            const linePrefix = document.lineAt(position).text.substring(0, position.character);
            // Vérification simple du contexte d'import
            if (!linePrefix.endsWith('import "') && !linePrefix.endsWith("import '")) return undefined;

            // Dossier contenant le fichier actuel
            const currentDir = path.dirname(document.uri.fsPath);

            if (!fs.existsSync(currentDir)) return [];

            const items = [];
            try {
                // On scanne le dossier du fichier actuel
                const files = fs.readdirSync(currentDir, { withFileTypes: true });

                for (const file of files) {
                    // On ne suggère pas le fichier lui-même
                    if (path.resolve(currentDir, file.name) === document.uri.fsPath) continue;

                    if (file.isDirectory()) {
                        // Suggérer les dossiers
                        const item = new vscode.CompletionItem(file.name + '/', vscode.CompletionItemKind.Folder);
                        // Commande pour ré-ouvrir l'autocomplétion après avoir sélectionné un dossier
                        item.command = { command: 'editor.action.triggerSuggest', title: 'Re-trigger suggestions' };
                        items.push(item);
                    }
                    else if (file.name.endsWith('.jmc')) {
                        // Suggérer les fichiers .jmc (sans l'extension)
                        const nameNoExt = file.name.slice(0, -4);
                        const item = new vscode.CompletionItem(nameNoExt, vscode.CompletionItemKind.File);
                        item.detail = 'JMC File';
                        items.push(item);
                    }
                }
            } catch (e) {
                console.error("Error reading directory for import completion:", e);
            }

            return items;
        }
    }, '"', "'", "/");

    // --- 2. Autocompletion GENERALE ---
    const snippetCompletionProvider = vscode.languages.registerCompletionItemProvider('jmc', {
        provideCompletionItems(document, position) {
            const items = [];
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

            Object.entries(snippets).forEach(([label, snippet]) => {
                const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Function);
                item.insertText = new vscode.SnippetString(snippet.body.join('\n'));
                const signature = getSignatureFromSnippet(snippet.body);
                item.documentation = new vscode.MarkdownString().appendCodeblock(signature, 'jmc').appendMarkdown(`\n\n${snippet.description || ''}`);
                items.push(item);
            });

            Object.entries(mcCommandDocs).forEach(([cmd, info]) => {
                const item = new vscode.CompletionItem(cmd, vscode.CompletionItemKind.Keyword);
                item.documentation = new vscode.MarkdownString().appendCodeblock(info.syntax, 'mcfunction').appendMarkdown(`\n\n${info.description}`);
                items.push(item);
            });

            if (workspaceFolder) {
                const scope = getGlobalScope(workspaceFolder.uri.fsPath, document);
                scope.functions.forEach((info, name) => {
                    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
                    item.detail = `User Function (${vscode.workspace.asRelativePath(info.filePath)})`;
                    items.push(item);
                });
                scope.classes.forEach((info, name) => {
                    items.push(new vscode.CompletionItem(name, vscode.CompletionItemKind.Class));
                });
                if (scope.scoreboards) {
                    scope.scoreboards.forEach((info, name) => {
                        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
                        item.detail = `Scoreboard Objective (${info.criteria})`;

                        const md = new vscode.MarkdownString();
                        md.appendCodeblock(`objective ${name}`, 'jmc');
                        md.appendMarkdown(`\n\n**Criteria**: \`${info.criteria}\``);
                        if (info.displayName) {
                            md.appendMarkdown(`\n**Display**: ${info.displayName}`);
                        }
                        item.documentation = md;

                        items.push(item);
                    });
                }
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
            // REGEX AJOUTÉE : Support du # pour les directives
            const range = document.getWordRangeAtPosition(position, /[#@$~^A-Za-z0-9_.:]+/);
            if (!range) return;

            const word = document.getText(range);
            const lineText = document.lineAt(position.line).text;

            // F. HJMC Directives (Priorité haute pour le #)
            if (word.startsWith('#') && hjmcDirectives[word]) {
                return new vscode.Hover(new vscode.MarkdownString().appendCodeblock(`${word}`).appendMarkdown(`\n\n${hjmcDirectives[word]}`), range);
            }

            // A. Clé NBT
            const keyRegex = new RegExp(`\\b${word}\\s*:\\s*(.*)`);
            const keyMatch = keyRegex.exec(lineText);
            if (keyMatch && !word.startsWith('$') && !word.includes('::')) {
                let val = keyMatch[1].trim().split(/[,\s;]/)[0];
                const type = inferNbtType(val);
                const md = new vscode.MarkdownString().appendCodeblock(`${word}: ${type}`, 'jmc');
                return new vscode.Hover(md, range);
            }

            // B. Variables
            if (word.startsWith('$') || word.includes('::')) {
                const md = new vscode.MarkdownString();
                if (word.startsWith('$')) {
                    md.appendCodeblock(`score ${word}: int`, 'jmc');
                } else {
                    const assignMatch = new RegExp(`${word.replace(/\./g, '\\.')}\\s*=\\s*([^;\\n]+)`, 'm').exec(document.getText());
                    let val = assignMatch ? assignMatch[1].trim().split(/[,\s]/)[0] : "";
                    if (val.startsWith('{')) val = '{'; else if (val.startsWith('[')) val = '[';
                    md.appendCodeblock(`storage ${word}: ${inferNbtType(val)}`, 'jmc');
                }
                return new vscode.Hover(md, range);
            }

            if (mcCommandDocs[word]) {
                const info = mcCommandDocs[word];
                return new vscode.Hover(new vscode.MarkdownString().appendCodeblock(info.syntax, 'mcfunction').appendMarkdown(`\n\n${info.description}`), range);
            }

            if (snippets[word]) {
                const sig = getSignatureFromSnippet(snippets[word].body);
                return new vscode.Hover(new vscode.MarkdownString().appendCodeblock(sig, 'jmc').appendMarkdown(`\n\n${snippets[word].description}`), range);
            }
            // --- NOUVEAU : Scoreboards ---
            // On gère le cas "obj:.score" -> on veut hover sur "obj"
            let objectiveName = word;
            if (word.includes(':') && !word.startsWith('::')) {
                objectiveName = word.split(':')[0]; // "myobj:.score" -> "myobj"
            }
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (workspaceFolder) {
                const scope = getGlobalScope(workspaceFolder.uri.fsPath, document);

                if (scope.scoreboards && scope.scoreboards.has(objectiveName)) {
                    const info = scope.scoreboards.get(objectiveName);
                    const md = new vscode.MarkdownString();
                    // Affichage type signature fonctionnelle
                    md.appendCodeblock(`Objective ${objectiveName}: ${info.criteria}`, 'jmc');
                    if (info.displayName) {
                        md.appendCodeblock(` => "${info.displayName}"`, 'jmc');
                    }
                    md.appendMarkdown(`\n\nDefined in \`${vscode.workspace.asRelativePath(info.filePath)}\` at line ${info.line + 1}`);
                    return new vscode.Hover(md, range);
                }

                if (scope.functions.has(word)) {
                    const info = scope.functions.get(word);
                    return new vscode.Hover(new vscode.MarkdownString(`User Function **${word}**\n\nDefined in \`${vscode.workspace.asRelativePath(info.filePath)}\``), range);
                }
            }
        }
    });

    // --- 7. HJMC Directives Completion ---
    const directiveCompletionProvider = vscode.languages.registerCompletionItemProvider('jmc', {
        provideCompletionItems(document, position) {
            const line = document.lineAt(position).text;
            const linePrefix = line.substring(0, position.character);

            if (!linePrefix.includes('#')) return undefined;

            // Déterminer la zone à remplacer (du # jusqu'au curseur)
            const hashIndex = linePrefix.lastIndexOf('#');
            const range = new vscode.Range(position.line, hashIndex, position.line, position.character);

            return Object.entries(hjmcDirectives).map(([label, desc]) => {
                const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Keyword);
                item.documentation = new vscode.MarkdownString(desc);
                item.range = range; // Force le remplacement du texte tapé
                return item;
            });
        }
    }, '#');

    // --- 5. Definition Provider ---
    const definitionProvider = vscode.languages.registerDefinitionProvider('jmc', {
        async provideDefinition(document, position) {
            const wordRange = document.getWordRangeAtPosition(position, /[#A-Za-z0-9_.:]+/);
            if (!wordRange) return null;
            let word = document.getText(wordRange);


            // Gestion "obj:.score"
            if (word.includes(':') && !word.startsWith('::')) {
                word = word.split(':')[0];
            }

            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (workspaceFolder) {
                const scope = getGlobalScope(workspaceFolder.uri.fsPath, document);
                // --- NOUVEAU : Scoreboards ---
                if (scope.scoreboards && scope.scoreboards.has(word)) {
                    const info = scope.scoreboards.get(word);
                    return new vscode.Location(vscode.Uri.file(info.filePath), new vscode.Position(info.line, 0));
                }
                if (scope.functions.has(word)) {
                    const info = scope.functions.get(word);
                    return new vscode.Location(vscode.Uri.file(info.filePath), new vscode.Position(info.line, 0));
                }
            }
            return null;
        }
    });

    const variableCompletionProvider = vscode.languages.registerCompletionItemProvider('jmc', {
        provideCompletionItems(document) {
            const variables = new Set();
            const importedFiles = getImportedFiles(document);
            for (const filePath of importedFiles) {
                if (!fs.existsSync(filePath)) continue;
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
                if (!fs.existsSync(filePath)) continue;
                const content = fs.readFileSync(filePath, 'utf8');
                const { storage } = extractVariables(content);
                for (const s of storage) storages.add(s);
            }
            return [...storages].map(v => new vscode.CompletionItem(v, vscode.CompletionItemKind.Variable));
        }
    }, ':');

    return [

        importCompletionProvider,
        snippetCompletionProvider,
        signatureProvider,
        hoverProvider,
        definitionProvider,
        variableCompletionProvider,
        storageCompletionProvider,
        directiveCompletionProvider
    ];
}

module.exports = { initProviders };
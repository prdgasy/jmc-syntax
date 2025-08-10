// src/diagnostics.js
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const { getDefinedFunctionsFromText, getAllCallIdentifiers } = require('./jmcParser');

const diagnostics = vscode.languages.createDiagnosticCollection('jmcDiagnostics');
const fadeDecoration = vscode.window.createTextEditorDecorationType({ opacity: '0.5' });
const unusedDecoration = vscode.window.createTextEditorDecorationType({ opacity: '0.5' });
const decoratorDecoration = vscode.window.createTextEditorDecorationType({ fontWeight: 'bold' });
const ignoreDecoration = vscode.window.createTextEditorDecorationType({
    fontWeight: 'bold',
});

const ignoreContentDecoration = vscode.window.createTextEditorDecorationType({
    fontStyle: 'italic',
});

const functionExceptionList = ['if', 'while', 'for'];
const jmcKeywords = ["class", "function", "if", "else", "for", "while", "return", "import"];
const mcCommands = [
    'advancement', 'attribute', 'ban', 'banip',
    'banlist', 'bossbar', 'clear', 'clone',
    'damage', 'data', 'datapack', 'debug',
    'defaultgamemode', 'deop', 'difficulty', 'effect',
    'enchant', 'execute', 'experience', 'fill',
    'fillbiome', 'forceload', 'function', 'gamemode',
    'gamerule', 'give', 'help', 'item', 'trigger',
    'jfr', 'kick', 'kill', 'list',
    'locate', 'loot', 'me', 'msg',
    'op', 'pardon', 'pardonip', 'particle',
    'place', 'playsound', 'publish', 'random',
    'recipe', 'reload', 'return', 'ride',
    'rotate', 'save', 'save-all', 'save-off',
    'save-on', 'say', 'schedule', 'scoreboard',
    'seed', 'setblock', 'setidletimeout', 'setworldspawn',
    'spawnpoint', 'spectate', 'spreadplayers', 'stop',
    'stopsound', 'summon', 'tag', 'team',
    'teammsg', 'teleport', 'tellraw',
    'tick', 'time', 'title', 'tp',
    'transfer', 'trigger', 'version', 'weather',
    'whitelist', 'worldborder'
];
let moduleSnippets = {};
let definedFunctionsInDoc = [];

function setDiagnosticsSnippets(snippets) {
    moduleSnippets = snippets;
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


function isRangeIgnored(range, ignoredZones) {
    for (const zone of ignoredZones) {
        // .intersection retourne la partie commune. Si non null, il y a chevauchement.
        if (zone.intersection(range)) {
            return true;
        }
    }
    return false;
}

function updateDiagnostics(document) {
    if (document.languageId !== 'jmc') return;

    const jmcFunctions = Object.keys(moduleSnippets);
    const text = document.getText();
    const diags = [];
    const decoratorRanges = [];
    const allowedDecorators = ['add', 'root', 'lazy', 'description', 'ignore', 'param'];
    const decoratorRegex = /@(\w+)/g;
    let match;
    while ((match = decoratorRegex.exec(text)) !== null) {
        if (allowedDecorators.includes(match[1])) {
            const start = document.positionAt(match.index);
            const end = document.positionAt(match.index + match[0].length);
            decoratorRanges.push(new vscode.Range(start, end));
        }
    }


    let fadeRanges = [];
    const fadeHoverMap = new Map();
    let unusedRanges = [];
    const unusedHoverMap = new Map();

    // --- NOUVELLE LOGIQUE : Trouver les blocs @ignore ---
    const ignoredZones = [];
    const ignoreMarkerRanges = [];
    const ignoreStartTag = '// @ignore(start)';
    const ignoreEndTag = '// @ignore(end)';

    let searchIndex = 0;
    while ((searchIndex = text.indexOf(ignoreStartTag, searchIndex)) !== -1) {
        const startPos = document.positionAt(searchIndex);
        const endSearchIndex = text.indexOf(ignoreEndTag, searchIndex);

        if (endSearchIndex !== -1) {
            const endPos = document.positionAt(endSearchIndex);

            // La zone à ignorer est entre les deux marqueurs
            const ignoreZone = new vscode.Range(startPos, endPos.translate(0, ignoreEndTag.length));
            ignoredZones.push(ignoreZone);

            // On ajoute les lignes des marqueurs pour les mettre en gras
            ignoreMarkerRanges.push(document.lineAt(startPos.line).range);
            ignoreMarkerRanges.push(document.lineAt(endPos.line).range);

            searchIndex = endSearchIndex + ignoreEndTag.length;
        } else {
            // Bloc non fermé, on arrête la recherche pour éviter les erreurs
            break;
        }
    }
    // --- FIN DE LA NOUVELLE LOGIQUE ---


    // Récupérer tous les fichiers importés (et le fichier courant)
    const importedFiles = getImportedFiles(document);

    const globalDefinedFunctions = new Set();
    const globalUsedFunctions = new Set();

    for (const filePath of importedFiles) {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, 'utf8');
        const cleanedContent = content.replace(/(\/\/|#).*/g, '');
        const definedFuncs = getDefinedFunctionsFromText(cleanedContent);
        const usedFuncs = getAllCallIdentifiers(cleanedContent);

        definedFuncs.forEach(f => globalDefinedFunctions.add(f));
        usedFuncs.forEach(f => globalUsedFunctions.add(f));
    }

    // Garder la logique de processCodeBlock et autres diag comme avant
    processCodeBlock(text, 0, 0, diags, jmcFunctions);

    // Liste des fonctions définies localement (pour le fichier actuel uniquement)
    // Combine les fonctions définies localement + globalement (importées)
    const definedFunctionsInDoc = getDefinedFunctionsFromText(text.replace(/(\/\/|#).*/g, ''));
    const localDefinedNames = definedFunctionsInDoc.map(d => d.split('.').pop());
    const globalDefinedNames = [...globalDefinedFunctions].map(f => f.split('.').pop());
    const allDefinedFunctionNames = new Set([...localDefinedNames, ...globalDefinedNames]);


    // Liste des fonctions appelées globalement (dans tous les fichiers importés)
    const simpleUsed = new Set([...globalUsedFunctions].map(f => f.split('.').pop()));

    const addDecoratedFunctions = new Set();
    const functionWithAddDecoratorRegex = /@add\s*(?:\([^)]*\))?\s*function\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    let addMatch;
    while ((addMatch = functionWithAddDecoratorRegex.exec(text)) !== null) {
        addDecoratedFunctions.add(addMatch[1]);
    }

    // Vérifier les appels de fonctions non définies dans le fichier actuel (fadeRanges)
    const usedFunctions = getAllCallIdentifiers(text.replace(/(\/\/|#).*/g, ''));

    usedFunctions.forEach(fullCallName => {
        const simpleName = fullCallName.split('.').pop();
        if (fullCallName.includes('del')) return;
        if (
            jmcFunctions.includes(fullCallName) ||
            allDefinedFunctionNames.has(simpleName) ||
            functionExceptionList.includes(simpleName.toLowerCase())
        ) {
            return;
        }


        const callRegex = new RegExp(`\\b${fullCallName.replace(/\./g, '\\.')}\\s*\\(`, 'g');
        let match;
        while ((match = callRegex.exec(text)) !== null) {
            if (match.index > 0 && text[match.index - 1] === '@') continue;
            const beforeText = text.slice(Math.max(0, match.index - 4), match.index);
            if (/new\s*$/.test(beforeText)) continue;
            if (/function\s*$/.test(text.slice(0, match.index))) continue;

            const pos = document.positionAt(match.index);
            const range = new vscode.Range(pos, pos.translate(0, fullCallName.length));
            fadeRanges.push(range);
            fadeHoverMap.set(range, `Function '${fullCallName}' is used but never defined.`);
        }
    });

    // Vérifier les fonctions définies mais non utilisées (unusedRanges) **avec la vue globale**
    allDefinedFunctionNames.forEach(simpleFnName => {
        if (addDecoratedFunctions.has(simpleFnName)) return;

        if (!simpleUsed.has(simpleFnName)) {
            const defRegex = new RegExp(`function\\s+([A-Za-z_][A-Za-z0-9_.]*\\.)?${simpleFnName}\\b`);
            const match = defRegex.exec(text);
            if (match) {
                const fullName = (match[1] || '') + simpleFnName;
                const startIndex = match.index + match[0].lastIndexOf(fullName);
                const startPos = document.positionAt(startIndex);
                const endPos = startPos.translate(0, fullName.length);
                const range = new vscode.Range(startPos, endPos);
                unusedRanges.push(range);
                unusedHoverMap.set(range, `Function '${fullName}' is declared but never used.`);
            }
        }
    });


    // --- NOUVELLE LOGIQUE : Filtrer les résultats qui sont dans une zone ignorée ---
    const finalDiags = diags.filter(d => !isRangeIgnored(d.range, ignoredZones));
    const finalFadeRanges = fadeRanges.filter(r => !isRangeIgnored(r, ignoredZones));
    const finalUnusedRanges = unusedRanges.filter(r => !isRangeIgnored(r, ignoredZones));
    // --- FIN DE LA NOUVELLE LOGIQUE ---


    diagnostics.set(document.uri, finalDiags);
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === document) {

        editor.setDecorations(decoratorDecoration, decoratorRanges);

        editor.setDecorations(fadeDecoration, finalFadeRanges);
        editor.setDecorations(unusedDecoration, finalUnusedRanges);
        editor.setDecorations(ignoreDecoration, ignoreMarkerRanges); // Appliquer la décoration en gras pour les marqueurs

        // --- NOUVEAU : Appliquer la décoration en italique pour toute la zone ignorée ---
        editor.setDecorations(ignoreContentDecoration, ignoredZones);
        // --- FIN DU NOUVEAU ---
    }
}


function findMatchingBrace(text, startIndex) {
    let depth = 1;
    for (let i = startIndex + 1; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}


function processCodeBlock(blockText, baseLine, baseOffset, diags, jmcFunctions) {
    const subBlocks = [];
    let searchText = blockText;
    let searchStartIndex = 0;

    // Pass 1: Identifier TOUS les blocs récursifs, les traiter, et les marquer pour nettoyage.
    while (searchStartIndex < searchText.length) {
        const openBraceIndex = searchText.indexOf('{', searchStartIndex);
        if (openBraceIndex === -1) break;

        const precedingText = searchText.substring(0, openBraceIndex).trimRight();
        const isArrowBlock = precedingText.endsWith('=>');
        const runBlockMatch = precedingText.match(/\b(run|execute)$/);

        if (isArrowBlock || runBlockMatch) {
            const closeBraceIndex = findMatchingBrace(searchText, openBraceIndex);
            if (closeBraceIndex !== -1) {
                const blockInfo = {
                    start: openBraceIndex,
                    end: closeBraceIndex + 1,
                    content: searchText.substring(openBraceIndex + 1, closeBraceIndex)
                };
                subBlocks.push(blockInfo);

                const precedingToBlock = searchText.substring(0, openBraceIndex + 1);
                const linesBefore = precedingToBlock.split('\n');
                const newBaseLine = baseLine + linesBefore.length - 1;
                const newBaseOffset = linesBefore.length > 1 ? linesBefore[linesBefore.length - 1].length : baseOffset + linesBefore[linesBefore.length - 1].length;

                processCodeBlock(blockInfo.content, newBaseLine, newBaseOffset, diags, jmcFunctions);

                searchStartIndex = closeBraceIndex + 1;
                continue;
            }
        }
        searchStartIndex = openBraceIndex + 1;
    }

    // Pass 2: Créer une version nettoyée du texte du bloc courant.
    let sanitizedBlockText = blockText.split('');
    for (const block of subBlocks) {
        for (let i = block.start + 1; i < block.end - 1; i++) {
            if (sanitizedBlockText[i] !== '\n') {
                sanitizedBlockText[i] = ' ';
            }
        }
    }
    sanitizedBlockText = sanitizedBlockText.join('');

    // Pass 3: Analyser le bloc nettoyé pour les erreurs locales.
    const lines = sanitizedBlockText.split('\n');
    let parenDepth = 0;

    for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        const currentLineNumber = baseLine + i;
        const currentOffset = (i === 0) ? baseOffset : 0;

        const commentIndex = Math.min(...['//', '#'].map(sym => { const idx = lineText.indexOf(sym); return idx === -1 ? Infinity : idx; }));
        const lineContent = (commentIndex === Infinity ? lineText : lineText.substring(0, commentIndex));
        // Couper la ligne à '::' pour ne pas analyser la partie avant '::'
        if (!lineContent.trim()) continue;
        let relevantLine = lineContent;
        const doubleColonIndex = lineContent.indexOf('::');
        if (doubleColonIndex !== -1) {
            relevantLine = lineContent.substring(doubleColonIndex);
        }



        const initialParenDepth = parenDepth;
        for (const char of lineContent) {
            if (char === '(') parenDepth++;
            else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
        }

        const segments = relevantLine.split(/(?<=;)/);
        let segmentOffset = 0;
        for (const segment of segments) {
            const trimmedSegment = segment.trim();
            if (trimmedSegment) {
                const isFunctionCall = trimmedSegment.includes('(');
                const isBraceBoundary = trimmedSegment.startsWith('{') || trimmedSegment.startsWith('}');

                if (initialParenDepth === 0 && !isFunctionCall && !isBraceBoundary) {
                    const matches = trimmedSegment.match(/^[^\s()]+/);
                    if (matches) {
                        const word = matches[0];
                        if (!isValid(word, jmcFunctions)) {
                            const wordStart = currentOffset + lineText.indexOf(word, segmentOffset);
                            const range = new vscode.Range(currentLineNumber, wordStart, currentLineNumber, wordStart + word.length);
                            diags.push(new vscode.Diagnostic(range, `Unknown command or function '${word}'`, vscode.DiagnosticSeverity.Error));
                        }
                    }
                }

                const isExempt =
                    trimmedSegment.endsWith(';') ||
                    trimmedSegment.endsWith('{') ||
                    trimmedSegment.endsWith('}') ||
                    trimmedSegment.endsWith(',') ||
                    /^\s*(function|if|for|while|class)\b/.test(trimmedSegment) ||
                    parenDepth > 0;
                // --- Ignorer les lignes qui sont uniquement un décorateur comme @add(__tick__)
                const isDecoratorLine = /^\s*@\w+(\([^)]*\))?\s*$/.test(trimmedSegment);
                if (isDecoratorLine) {
                    segmentOffset += segment.length;
                    continue;
                }

                if (!isExempt) {
                    const errorPos = currentOffset + lineText.indexOf(segment, segmentOffset) + segment.trimEnd().length;
                    const range = new vscode.Range(currentLineNumber, errorPos, currentLineNumber, errorPos + 1);
                    diags.push(new vscode.Diagnostic(range, "Missing semicolon ';'", vscode.DiagnosticSeverity.Warning));
                }
            }
            segmentOffset += segment.length;
        }
    }
}


function isValid(word, jmcFunctions) {
    const allValid = [...jmcKeywords, ...mcCommands, ...jmcFunctions, ...definedFunctionsInDoc.map(d => d.split('.').pop())];
    return allValid.some(cmd => cmd.toLowerCase() === word.toLowerCase()) || word.startsWith('$') || word.includes('::') || word.includes('@');
}


function initDiagnostics(context) {
    const update = (doc) => updateDiagnostics(doc);
    vscode.workspace.onDidChangeTextDocument(e => update(e.document), null, context.subscriptions);
    vscode.workspace.onDidOpenTextDocument(update, null, context.subscriptions);
    vscode.window.onDidChangeActiveTextEditor(e => e && update(e.document), null, context.subscriptions);
    if (vscode.window.activeTextEditor) {
        update(vscode.window.activeTextEditor.document);
    }

    return [diagnostics];
}

module.exports = {
    initDiagnostics,
    setDiagnosticsSnippets
};
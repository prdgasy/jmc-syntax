const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { getGlobalScope } = require('./jmcParser');
const { jmcKeywords, mcCommands } = require('./constants');

// --- Décorations ---
const decoratorDecoration = vscode.window.createTextEditorDecorationType({ fontWeight: 'bold' });
const ignoreDecoration = vscode.window.createTextEditorDecorationType({ fontWeight: 'bold' });
const ignoreContentDecoration = vscode.window.createTextEditorDecorationType({ fontStyle: 'italic' });

let moduleSnippets = {};

function setLinterSnippets(snippets) {
    moduleSnippets = snippets;
}

// --- Fonctions Utilitaires ---

function isRangeIgnored(range, ignoredZones) {
    for (const zone of ignoredZones) {
        if (zone.intersection(range)) return true;
    }
    return false;
}

function isValid(word, jmcFunctions, globalScope) {
    const allValid = [
        ...jmcKeywords,
        ...mcCommands,
        ...jmcFunctions,
        ...Array.from(globalScope.functions.keys()),
        ...Array.from(globalScope.classes.keys())
    ];
    return allValid.some(cmd => cmd.toLowerCase() === word.toLowerCase())
        || word.startsWith('$')
        || word.includes('::')
        || word.includes('@');
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

// --- Validateurs ---

function validateImports(document, diags, ignoredZones) {
    const text = document.getText();
    const importRegex = /^\s*import\s+"([^"]+)"/gm;
    // On utilise le dossier du fichier comme base
    const docDir = path.dirname(document.uri.fsPath);

    let match;
    while ((match = importRegex.exec(text)) !== null) {
        const importPath = match[1];
        if (importPath.includes('*')) continue; // On ignore les wildcards pour la vérif d'existence simple

        let targetPath = importPath;
        if (!targetPath.endsWith('.jmc')) targetPath += '.jmc';

        const absPath = path.resolve(docDir, targetPath);

        if (!fs.existsSync(absPath)) {
            const startPos = document.positionAt(match.index);
            const range = new vscode.Range(startPos, startPos.translate(0, match[0].length));
            if (!isRangeIgnored(range, ignoredZones)) {
                diags.push(new vscode.Diagnostic(range, `File '${targetPath}' not found.`, vscode.DiagnosticSeverity.Error));
            }
        }
    }
}

function validateStructureAndSemicolons(document, diags, ignoredZones) {
    const text = document.getText();
    const tokenRegex = /(\/\/.*$|#.*$|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[\s\S]*?`|\b(class|function|if|while|for|switch)\b|(\$|::)[\w.]+\s*(:?)=|;|,|\{|\}|\[|\])/gm;

    let match;
    const stack = [];

    while ((match = tokenRegex.exec(text)) !== null) {
        const token = match[0];
        const index = match.index;

        if (token.startsWith('//') || token.startsWith('#') || token.startsWith('/*') || token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) continue;

        if (token === '{') {
            let needsSemi = true;
            // Regarder en arrière pour voir si c'est un bloc de définition
            const lookback = text.substring(Math.max(0, index - 100), index).trim();
            // Regex ajustée pour attraper "function foo() " ou "if (...) " juste avant
            if (/(class|function|if|else|for|while|switch|case|default)(\s+[\w.]+)?(\s*\(.*\))?\s*$/.test(lookback)) {
                needsSemi = false;
            }
            stack.push({ type: 'brace', startPos: index, needsSemi });
        }
        else if (token === '[') {
            stack.push({ type: 'bracket', startPos: index, needsSemi: true });
        }
        else if (token === '}' || token === ']') {
            if (stack.length === 0) continue;
            const block = stack.pop();

            if ((token === '}' && block.type !== 'brace') || (token === ']' && block.type !== 'bracket')) continue;

            if (block.needsSemi) {
                const parent = stack.length > 0 ? stack[stack.length - 1] : null;
                const isInsideStructure = parent && (parent.type === 'brace' || parent.type === 'bracket');

                if (!isInsideStructure) {
                    const remaining = text.slice(index + 1);
                    // On cherche le prochain mot significatif
                    const nextWordMatch = remaining.match(/^\s*([a-zA-Z0-9_]+|;)/);

                    // --- CORRECTION POUR 'with' ---
                    // Si le prochain mot est 'with', alors ce n'est PAS la fin de l'instruction.
                    // On ne demande pas de point-virgule ICI.
                    if (nextWordMatch && nextWordMatch[1] === 'with') {
                        continue; // On passe, le ; sera vérifié à la fin de la ligne 'with ...' par validateSimpleAssignments
                    }
                    // -----------------------------

                    if (!nextWordMatch || nextWordMatch[1] !== ';') {
                        const pos = document.positionAt(index + 1);
                        const range = new vscode.Range(pos, pos.translate(0, 1));
                        if (!isRangeIgnored(range, ignoredZones)) {
                            diags.push(new vscode.Diagnostic(range, "Linter: Missing semicolon ';' after block or list.", vscode.DiagnosticSeverity.Error));
                        }
                    }
                }
            }
        }
    }
}

function validateSimpleAssignments(document, diags, ignoredZones) {
    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        const textLine = line.text.trim();

        // Ignorer lignes vides ou commentaires
        if (!textLine || textLine.startsWith('//') || textLine.startsWith('#')) continue;

        // --- FILTRES D'EXCLUSION ---

        // 1. Si la ligne finit par une ouverture ou une virgule, ce n'est pas une fin d'instruction
        if (textLine.endsWith(',') || textLine.endsWith('{') || textLine.endsWith('[')) continue;

        // 2. Si c'est une propriété JSON/Objet (ex: "key": value ou key: value)
        // Mais attention aux scores (score $var: int) ou commandes JMC avec :
        // On exclut les assignations de variables (::var = ...) qui contiennent des :
        if (/^[\w"']+\s*:/.test(textLine) && !textLine.includes('=')) {
            // C'est probablement une clé d'objet, on ignore
            continue;
        }

        // 3. Si c'est une annotation (@add) ou une fermeture de bloc seule (})
        if (textLine.startsWith('@') || textLine === '}' || textLine === ']') continue;

        // --- DETECTION D'ERREUR ---

        // Cas A : Assignation de variable ($var = ... ou ::var = ...)
        const isAssignment = (textLine.startsWith('$') || textLine.startsWith('::')) && textLine.includes('=');

        // Cas B : Commande simple (commence par une lettre, n'est pas un mot clé de structure)
        // Mots clés à ignorer car ils gèrent leurs propres blocs ou syntaxes
        const controlKeywords = [
            'if', 'while', 'for', 'class', 'function', 'import', 'new',
            'else', 'switch', 'case', 'default', 'return', 'do'
        ];
        // On vérifie que le premier mot n'est pas un mot clé
        const firstWord = textLine.split(/[^\w]/)[0];
        const isCommand = /^[a-z]/.test(textLine) && !controlKeywords.includes(firstWord);

        if (isAssignment || isCommand) {
            // Nettoyage commentaire fin de ligne pour vérifier le dernier caractère réel
            const cleanText = textLine.replace(/(\/\/|#).*$/, '').trim();
            if (!cleanText) continue;

            const lastChar = cleanText.slice(-1);

            // Si ça ne finit pas par ; (et que ce n'est pas une fermeture ou une virgule)
            if (![';', '{', '}', '[', ']', ','].includes(lastChar)) {
                const range = new vscode.Range(i, line.text.length, i, line.text.length);
                if (!isRangeIgnored(range, ignoredZones)) {
                    diags.push(new vscode.Diagnostic(
                        range,
                        "Linter: Missing semicolon ';' at end of instruction.",
                        vscode.DiagnosticSeverity.Error
                    ));
                }
            }
        }
    }
}

function processCodeBlock(blockText, baseLine, baseOffset, diags, jmcFunctions, globalScope) {
    const subBlocks = [];
    let searchText = blockText;
    let searchStartIndex = 0;

    // 1. Masquer les blocs { }
    while (searchStartIndex < searchText.length) {
        const openBraceIndex = searchText.indexOf('{', searchStartIndex);
        if (openBraceIndex === -1) break;
        const closeBraceIndex = findMatchingBrace(searchText, openBraceIndex);

        if (closeBraceIndex !== -1) {
            const blockContent = searchText.substring(openBraceIndex + 1, closeBraceIndex);

            // On vérifie si c'est un bloc de commande (ex: execute run { ... })
            // Si OUI, on veut analyser l'intérieur. Si NON (ex: json), on ignore.
            const preceding = searchText.substring(0, openBraceIndex).trim();
            const isCommandBlock = preceding.endsWith('run') || preceding.endsWith('=>') || preceding.endsWith('else') || preceding.match(/(function|class|if|while|for|switch)\s*[\w\(\)]*$/);

            if (isCommandBlock) {
                const precedingLines = searchText.substring(0, openBraceIndex + 1).split('\n');
                const newBaseLine = baseLine + precedingLines.length - 1;
                const newBaseOffset = precedingLines.length > 1 ? precedingLines[precedingLines.length - 1].length : baseOffset + precedingLines[0].length;
                processCodeBlock(blockContent, newBaseLine, newBaseOffset, diags, jmcFunctions, globalScope);
            }

            subBlocks.push({ start: openBraceIndex, end: closeBraceIndex });
            searchStartIndex = closeBraceIndex + 1;
        } else break;
    }

    // 2. Masquer les listes [ ] (Récursif)
    searchStartIndex = 0;
    while (searchStartIndex < searchText.length) {
        const openIndex = searchText.indexOf('[', searchStartIndex);
        if (openIndex === -1) break;
        let depth = 1;
        let closeIndex = -1;
        for (let i = openIndex + 1; i < searchText.length; i++) {
            if (searchText[i] === '[') depth++;
            else if (searchText[i] === ']') {
                depth--;
                if (depth === 0) { closeIndex = i; break; }
            }
        }
        if (closeIndex !== -1) {
            subBlocks.push({ start: openIndex, end: closeIndex });
            searchStartIndex = closeIndex + 1;
        } else break;
    }

    // 3. Masquage
    let sanitizedText = blockText.split('');
    for (const block of subBlocks) {
        for (let i = block.start; i <= block.end; i++) {
            if (sanitizedText[i] !== '\n') sanitizedText[i] = ' ';
        }
    }
    const cleanText = sanitizedText.join('');

    // 4. Analyse des commandes
    const lines = cleanText.split('\n');
    for (let i = 0; i < lines.length; i++) {
        let lineText = lines[i];
        const currentLineNumber = baseLine + i;
        const currentOffset = (i === 0) ? baseOffset : 0;

        const commentIndex = Math.min(
            lineText.indexOf('//') === -1 ? Infinity : lineText.indexOf('//'),
            lineText.indexOf('#') === -1 ? Infinity : lineText.indexOf('#')
        );
        if (commentIndex !== Infinity) lineText = lineText.substring(0, commentIndex);
        if (!lineText.trim()) continue;

        const segments = lineText.split(';');
        let segOffset = 0;

        for (const segment of segments) {
            const trimmed = segment.trim();
            if (!trimmed) { segOffset += segment.length + 1; continue; }

            const firstWordMatch = trimmed.match(/^([a-zA-Z0-9_.]+)/);
            if (firstWordMatch) {
                const word = firstWordMatch[1];

                // Filtres pour éviter les faux positifs
                if (/^\d+$/.test(word)) continue; // Chiffres
                if (trimmed.endsWith(',')) continue; // Élément de liste/struct
                if (word.includes(':')) continue; // Clé JSON probable

                if (!['if', 'else', 'while', 'for', 'class', 'function', 'return', 'import', 'new', 'switch', 'case', 'default'].includes(word) &&
                    !word.startsWith('$') && !word.startsWith('::') && !word.startsWith('@')) {

                    if (!isValid(word, jmcFunctions, globalScope)) {
                        const wordIdx = lineText.indexOf(word, segOffset);
                        const range = new vscode.Range(currentLineNumber, currentOffset + wordIdx, currentLineNumber, currentOffset + wordIdx + word.length);
                        diags.push(new vscode.Diagnostic(range, `Linter: Unknown command or function '${word}'`, vscode.DiagnosticSeverity.Error));
                    }
                }
            }
            segOffset += segment.length + 1;
        }
    }
}

// --- Fonction Principale (Interface pour diagnostics.js) ---

function getLinterDiagnosticsForWorkspace(entryDocument) {
    const diagnosticsMap = new Map();
    // On analyse uniquement le document actif pour les performances et la pertinence
    // Les erreurs d'import (fichier manquant) sont gérées dans validateImports

    const result = lintSingleDocument(entryDocument);
    diagnosticsMap.set(entryDocument.uri.fsPath, result.diagnostics);

    return {
        diagnosticsMap: diagnosticsMap,
        decorations: result.decorations,
        // On renvoie aussi la liste simple pour le code existant qui l'utiliserait
        diagnostics: result.diagnostics
    };
}

function lintSingleDocument(document) {
    const jmcFunctions = Object.keys(moduleSnippets);
    const text = document.getText();
    const diags = [];
    const decorationRanges = { decorator: [], ignoreMarker: [], ignoreContent: [] };

    // 1. Ignore Zones
    const ignoredZones = [];
    let searchIndex = 0;
    while ((searchIndex = text.indexOf('// @ignore(start)', searchIndex)) !== -1) {
        const startPos = document.positionAt(searchIndex);
        const endSearchIndex = text.indexOf('// @ignore(end)', searchIndex);
        if (endSearchIndex !== -1) {
            const endPos = document.positionAt(endSearchIndex);
            const ignoreZone = new vscode.Range(startPos, endPos.translate(0, 14));
            ignoredZones.push(ignoreZone);
            decorationRanges.ignoreContent.push(ignoreZone);
            decorationRanges.ignoreMarker.push(document.lineAt(startPos.line).range);
            decorationRanges.ignoreMarker.push(document.lineAt(endPos.line).range);
            searchIndex = endSearchIndex + 14;
        } else break;
    }

    // 2. Decorators
    const decoratorRegex = /@(\w+)/g;
    let dMatch;
    while ((dMatch = decoratorRegex.exec(text)) !== null) {
        decorationRanges.decorator.push(new vscode.Range(document.positionAt(dMatch.index), document.positionAt(dMatch.index + dMatch[0].length)));
    }

    // 3. Global Scope (Fonctions & Classes)
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const rootPath = workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(document.uri.fsPath);
    const globalScope = getGlobalScope(rootPath, document);

    // 4. Validations
    validateImports(document, diags, ignoredZones);
    validateStructureAndSemicolons(document, diags, ignoredZones);
    validateSimpleAssignments(document, diags, ignoredZones);
    processCodeBlock(text, 0, 0, diags, jmcFunctions, globalScope);

    // 5. Storage Operators
    const storageOpRegex = /(:[-+\*\/%]?=)/g;
    const storageVarRegex = /([a-zA-Z0-9_.]*::[a-zA-Z0-9_.]+)/g;
    for (let i = 0; i < document.lineCount; i++) {
        const lineText = document.lineAt(i).text.split('//')[0];
        let opMatch;
        while ((opMatch = storageOpRegex.exec(lineText)) !== null) {
            const rhsStart = opMatch.index + opMatch[0].length;
            const rhsText = lineText.substring(rhsStart);
            let varMatch;
            while ((varMatch = storageVarRegex.exec(rhsText)) !== null) {
                const varName = varMatch[0];
                const absIndex = rhsStart + varMatch.index;
                const before = lineText.substring(0, absIndex).trimEnd();
                const after = lineText.substring(absIndex + varName.length).trimStart();
                if (!before.endsWith('{') || !after.startsWith('}')) {
                    const range = new vscode.Range(i, absIndex, i, absIndex + varName.length);
                    if (!isRangeIgnored(range, ignoredZones)) {
                        diags.push(new vscode.Diagnostic(range, `Linter: Storage variable '${varName}' must be wrapped in { }.`, vscode.DiagnosticSeverity.Error));
                    }
                }
            }
        }
    }

    const finalDiags = diags.filter(d => !isRangeIgnored(d.range, ignoredZones));
    finalDiags.forEach(d => d.source = "Linter");

    return { diagnostics: finalDiags, decorations: decorationRanges };
}

function applyDecorations(editor, ranges) {
    editor.setDecorations(decoratorDecoration, ranges.decorator);
    editor.setDecorations(ignoreDecoration, ranges.ignoreMarker);
    editor.setDecorations(ignoreContentDecoration, ranges.ignoreContent);
}

function clearDecorations(editor) {
    editor.setDecorations(decoratorDecoration, []);
    editor.setDecorations(ignoreDecoration, []);
    editor.setDecorations(ignoreContentDecoration, []);
}

module.exports = {
    setLinterSnippets,
    getLinterDiagnosticsForWorkspace,
    getLinterDiagnostics: lintSingleDocument, // Alias pour compatibilité
    applyDecorations,
    clearDecorations
};
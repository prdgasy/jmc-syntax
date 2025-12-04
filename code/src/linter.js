const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { getDefinedFunctionsFromText, getAllCallIdentifiers } = require('./jmcParser');
const { jmcKeywords, mcCommands, functionExceptionList } = require('./constants');

// --- Décorations Visuelles ---
const fadeDecoration = vscode.window.createTextEditorDecorationType({ opacity: '0.5' });
const unusedDecoration = vscode.window.createTextEditorDecorationType({ opacity: '0.5' });
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

function getImportedFiles(document) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const rootPath = workspaceFolder?.uri.fsPath;
    if (!rootPath) return [];

    const text = document.getText();
    const importRegex = /^\s*import\s+"([^"]+)"/gm;
    const importedFiles = new Set();
    let match;

    while ((match = importRegex.exec(text)) !== null) {
        let importPath = match[1];
        if (importPath.endsWith('/*')) {
            // Logique dossier simplifiée : on pourrait lister le dossier ici
            const folderRelative = importPath.slice(0, -2);
            const folderFullPath = path.resolve(rootPath, folderRelative);
            if (fs.existsSync(folderFullPath) && fs.statSync(folderFullPath).isDirectory()) {
                try {
                    const files = fs.readdirSync(folderFullPath);
                    files.filter(f => f.endsWith('.jmc')).forEach(f => importedFiles.add(path.resolve(folderFullPath, f)));
                } catch (e) { }
            }
        } else {
            if (!importPath.endsWith('.jmc')) importPath += '.jmc';
            const fullPath = path.resolve(rootPath, importPath);
            if (fs.existsSync(fullPath)) importedFiles.add(fullPath);
        }
    }
    importedFiles.add(path.resolve(document.uri.fsPath));
    return [...importedFiles];
}

function isValid(word, jmcFunctions, definedFunctionsInDoc) {
    const localNames = definedFunctionsInDoc.map(d => d.split('.').pop());
    const allValid = [...jmcKeywords, ...mcCommands, ...jmcFunctions, ...localNames];
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

// --- Validateurs Spécifiques ---

/**
 * 1. Validateur par Pile (Stack) pour Structures et Semicolons
 * Gère ::dict = ['a', 'b']; et execute { }
 */
function validateStructureAndSemicolons(document, diags, ignoredZones) {
    const text = document.getText();
    const tokenRegex = /(\/\/.*$|#.*$|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[\s\S]*?`|\b(class|function|if|while|for|switch)\b|(\$|::)[\w.]+\s*(:?)=|;|,|\{|\}|\[|\])/gm;

    let match;
    const stack = [];

    while ((match = tokenRegex.exec(text)) !== null) {
        const token = match[0];
        const index = match.index;

        if (token.startsWith('//') || token.startsWith('#') || token.startsWith('/*') || token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) continue;

        // Détection contextuelle pour savoir si une accolade aura besoin d'un point-virgule
        if (token === '{') {
            let needsSemi = true;
            // On regarde un peu avant pour voir si c'est une définition de bloc (function, if...)
            const lookback = text.substring(Math.max(0, index - 50), index).trim();
            if (/(class|function|if|else|for|while|switch|case|default)\s*[\w\(\)]*$/.test(lookback)) {
                needsSemi = false;
            }
            stack.push({ type: 'brace', startPos: index, needsSemi });
        }
        else if (token === '[') {
            // Une liste a toujours besoin d'un point-virgule si elle est utilisée comme valeur d'assignation
            stack.push({ type: 'bracket', startPos: index, needsSemi: true });
        }
        else if (token === '}' || token === ']') {
            if (stack.length === 0) continue;
            const block = stack.pop();

            // Vérification simple de correspondance (optionnelle ici)
            if ((token === '}' && block.type !== 'brace') || (token === ']' && block.type !== 'bracket')) continue;

            if (block.needsSemi) {
                // On vérifie si on est à l'intérieur d'une autre structure
                const parent = stack.length > 0 ? stack[stack.length - 1] : null;
                const isInsideStructure = parent && (parent.type === 'brace' || parent.type === 'bracket');

                // Si on n'est pas dans une structure, on doit avoir un ;
                if (!isInsideStructure) {
                    const remaining = text.slice(index + 1);
                    const nextContentMatch = remaining.match(/^\s*(\S)/);

                    if (!nextContentMatch || nextContentMatch[1] !== ';') {
                        const pos = document.positionAt(index + 1);
                        const range = new vscode.Range(pos, pos.translate(0, 1));
                        if (!isRangeIgnored(range, ignoredZones)) {
                            diags.push(new vscode.Diagnostic(range, "Missing semicolon ';' after block or list.", vscode.DiagnosticSeverity.Error));
                        }
                    }
                }
            }
        }
    }
}

/**
 * 2. Validateur Ligne par Ligne pour Assignations Simples
 * Gère $var = 3 et commandes simples sans blocs
 */
function validateSimpleAssignments(document, diags, ignoredZones) {
    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        const text = line.text.trim();

        if (!text || text.startsWith('//') || text.startsWith('#')) continue;

        // Assignations ($a = 1) ou Commandes (say 'hi') qui ne finissent pas par ; { } [ ] ,
        if (((text.startsWith('$') || text.startsWith('::')) && text.includes('=')) ||
            (/^[a-z]/.test(text) && !['if', 'while', 'for', 'class', 'function', 'import', 'new', 'else', 'switch', 'case', 'default'].some(k => text.startsWith(k)))) {

            // Nettoyage commentaire fin de ligne
            const cleanText = text.replace(/(\/\/|#).*$/, '').trim();
            if (!cleanText) continue;

            const lastChar = cleanText.slice(-1);
            if (![';', '{', '}', '[', ']', ','].includes(lastChar)) {
                // Vérifier si c'est une annotation @
                if (cleanText.startsWith('@')) continue;

                const range = new vscode.Range(i, line.text.length, i, line.text.length);
                if (!isRangeIgnored(range, ignoredZones)) {
                    diags.push(new vscode.Diagnostic(range, "Missing semicolon ';' at end of instruction.", vscode.DiagnosticSeverity.Error));
                }
            }
        }
    }
}

/**
 * 3. Validateur Récursif pour Commandes Inconnues
 */
function processCodeBlock(blockText, baseLine, baseOffset, diags, jmcFunctions, definedFunctionsInDoc) {
    const subBlocks = [];
    let searchText = blockText;
    let searchStartIndex = 0;

    // 1. Extraire les blocs { } pour ne pas analyser leur contenu comme du texte plat
    while (searchStartIndex < searchText.length) {
        const openBraceIndex = searchText.indexOf('{', searchStartIndex);
        if (openBraceIndex === -1) break;

        const closeBraceIndex = findMatchingBrace(searchText, openBraceIndex);
        if (closeBraceIndex !== -1) {
            const blockContent = searchText.substring(openBraceIndex + 1, closeBraceIndex);

            // On calcule la nouvelle position pour la récursion
            const precedingLines = searchText.substring(0, openBraceIndex + 1).split('\n');
            const newBaseLine = baseLine + precedingLines.length - 1;
            const newBaseOffset = precedingLines.length > 1 ? precedingLines[precedingLines.length - 1].length : baseOffset + precedingLines[0].length;

            // Appel récursif
            processCodeBlock(blockContent, newBaseLine, newBaseOffset, diags, jmcFunctions, definedFunctionsInDoc);

            // On masque le contenu du bloc dans le texte courant pour ne pas le re-scanner
            // On remplace par des espaces pour garder les indices de ligne corrects
            let mask = "";
            for (let c of blockContent) mask += (c === '\n' ? '\n' : ' ');

            // On reconstruit une string "sanitized" locale (virtuellement)
            // Pour simplifier, on ignore juste la zone dans la boucle suivante
            subBlocks.push({ start: openBraceIndex, end: closeBraceIndex });

            searchStartIndex = closeBraceIndex + 1;
        } else {
            break;
        }
    }

    // 2. Analyser le texte (en sautant les blocs identifiés)
    const lines = blockText.split('\n');
    let parenDepth = 0;

    for (let i = 0; i < lines.length; i++) {
        let lineText = lines[i];
        const currentLineNumber = baseLine + i;
        const currentOffset = (i === 0) ? baseOffset : 0;

        // Nettoyage commentaires
        const commentIndex = Math.min(
            lineText.indexOf('//') === -1 ? Infinity : lineText.indexOf('//'),
            lineText.indexOf('#') === -1 ? Infinity : lineText.indexOf('#')
        );
        if (commentIndex !== Infinity) lineText = lineText.substring(0, commentIndex);
        if (!lineText.trim()) continue;

        // Vérif simple des commandes (premier mot)
        const segments = lineText.split(';'); // Gérer plusieurs commandes sur une ligne
        let segOffset = 0;

        for (const segment of segments) {
            const trimmed = segment.trim();
            if (!trimmed) { segOffset += segment.length + 1; continue; }

            // Si c'est un début de commande (pas dans une parenthèse, pas une fermeture)
            // On fait simple: on prend le premier mot
            const firstWordMatch = trimmed.match(/^([a-zA-Z0-9_.]+)/);
            if (firstWordMatch) {
                const word = firstWordMatch[1];

                // Est-ce une commande valide ?
                // On exclut les mots clés structurels et les variables
                if (!['if', 'else', 'while', 'for', 'class', 'function', 'return', 'import', 'new', 'switch', 'case', 'default'].includes(word) &&
                    !word.startsWith('$') && !word.startsWith('::') && !word.startsWith('@')) {

                    if (!isValid(word, jmcFunctions, definedFunctionsInDoc)) {
                        const wordIdx = lineText.indexOf(word, segOffset);
                        const range = new vscode.Range(currentLineNumber, currentOffset + wordIdx, currentLineNumber, currentOffset + wordIdx + word.length);
                        diags.push(new vscode.Diagnostic(range, `Unknown command or function '${word}'`, vscode.DiagnosticSeverity.Error));
                    }
                }
            }
            segOffset += segment.length + 1;
        }
    }
}

// --- Fonction Principale ---

function getLinterDiagnostics(document) {
    const jmcFunctions = Object.keys(moduleSnippets);
    const text = document.getText();
    const diags = [];

    const decorationRanges = {
        decorator: [], fade: [], unused: [], ignoreMarker: [], ignoreContent: []
    };

    // 1. Zones Ignorées
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

    // 2. Décorateurs
    const decoratorRegex = /@(\w+)/g;
    let dMatch;
    while ((dMatch = decoratorRegex.exec(text)) !== null) {
        decorationRanges.decorator.push(new vscode.Range(document.positionAt(dMatch.index), document.positionAt(dMatch.index + dMatch[0].length)));
    }

    // 3. Analyse Globale des Fonctions (pour unused/unknown)
    const importedFiles = getImportedFiles(document);
    const globalDefinedFunctions = new Set();
    const globalUsedFunctions = new Set();

    for (const filePath of importedFiles) {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, 'utf8').replace(/(\/\/|#).*/g, '');
        getDefinedFunctionsFromText(content).forEach(f => globalDefinedFunctions.add(f));
        getAllCallIdentifiers(content).forEach(f => globalUsedFunctions.add(f));
    }

    const definedFunctionsInDoc = getDefinedFunctionsFromText(text.replace(/(\/\/|#).*/g, ''));
    // Pour isValid, on a besoin de la liste complète des fonctions définies (locales + importées)
    // definedFunctionsInDoc ici ne contient que les locales, on fusionne pour le validateur :
    const allAvailableFunctions = [...definedFunctionsInDoc, ...globalDefinedFunctions];

    // 4. Exécuter les validateurs
    processCodeBlock(text, 0, 0, diags, jmcFunctions, allAvailableFunctions);
    validateStructureAndSemicolons(document, diags, ignoredZones);
    validateSimpleAssignments(document, diags, ignoredZones);

    // 5. Validateur Storage Opérateur (:=)
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
                        diags.push(new vscode.Diagnostic(range, `Storage variable '${varName}' must be wrapped in { }.`, vscode.DiagnosticSeverity.Error));
                    }
                }
            }
        }
    }

    // 6. Gestion Unused / Fade (Fonctions définies mais pas utilisées)
    const localDefinedNames = definedFunctionsInDoc.map(d => d.split('.').pop());
    const simpleUsed = new Set([...globalUsedFunctions].map(f => f.split('.').pop()));

    // Détecter @add pour ne pas marquer unused
    const addDecorated = new Set();
    let addMatch;
    const addRegex = /@add\s*(?:\([^)]*\))?\s*function\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    while ((addMatch = addRegex.exec(text)) !== null) addDecorated.add(addMatch[1]);

    localDefinedNames.forEach(fn => {
        if (!simpleUsed.has(fn) && !addDecorated.has(fn)) {
            const defRegex = new RegExp(`function\\s+([A-Za-z_][A-Za-z0-9_.]*\\.)?${fn}\\b`);
            const match = defRegex.exec(text);
            if (match) {
                const fullName = (match[1] || '') + fn;
                const startPos = document.positionAt(match.index + match[0].lastIndexOf(fullName));
                const range = new vscode.Range(startPos, startPos.translate(0, fullName.length));
                if (!isRangeIgnored(range, ignoredZones)) decorationRanges.unused.push(range);
            }
        }
    });

    const finalDiags = diags.filter(d => !isRangeIgnored(d.range, ignoredZones));
    finalDiags.forEach(d => d.source = "Linter");

    return { diagnostics: finalDiags, decorations: decorationRanges };
}

function applyDecorations(editor, ranges) {
    editor.setDecorations(decoratorDecoration, ranges.decorator);
    editor.setDecorations(fadeDecoration, ranges.fade);
    editor.setDecorations(unusedDecoration, ranges.unused);
    editor.setDecorations(ignoreDecoration, ranges.ignoreMarker);
    editor.setDecorations(ignoreContentDecoration, ranges.ignoreContent);
}

function clearDecorations(editor) {
    editor.setDecorations(decoratorDecoration, []);
    editor.setDecorations(fadeDecoration, []);
    editor.setDecorations(unusedDecoration, []);
    editor.setDecorations(ignoreDecoration, []);
    editor.setDecorations(ignoreContentDecoration, []);
}

module.exports = {
    setLinterSnippets,
    getLinterDiagnostics,
    applyDecorations,
    clearDecorations
};
// src/diagnostics.js
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const { getDefinedFunctionsFromText, getAllCallIdentifiers } = require('./jmcParser');
const { jmcKeywords, mcCommands, functionExceptionList } = require('./constants');

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

let moduleSnippets = {};
// Cette variable doit être globale pour être vue par isValid
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

        if (importPath.endsWith('/*')) {
            const folderRelative = importPath.slice(0, -2);
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
            const files = fs.readdirSync(rootPath);
            for (const f of files) {
                if (f.endsWith('.jmc')) {
                    importedFiles.add(path.resolve(rootPath, f));
                }
            }
        }
        else {
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

    importedFiles.add(path.resolve(document.uri.fsPath));
    return [...importedFiles];
}


function isRangeIgnored(range, ignoredZones) {
    for (const zone of ignoredZones) {
        if (zone.intersection(range)) {
            return true;
        }
    }
    return false;
}

function validateSemicolonsAndStructures(document, diags, ignoredZones) {
    const text = document.getText();

    // Regex pour repérer :
    // 1. Débuts de blocs nommés (class, function, if, while, for) -> PAS DE ; APRES }
    // 2. Assignations ($v =, ::v =) -> BESOIN DE ; APRES }
    // 3. Commandes (execute ..., timer.add ...) -> BESOIN DE ; APRES } SI BLOC
    // 4. Structures ({ key: val }) -> BESOIN DE , ET ;

    // On va parcourir le texte caractère par caractère pour gérer l'imbrication { }
    // C'est plus fiable que les regex pures pour le multi-lignes.

    const tokenRegex = /(\/\/.*$|#.*$|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[\s\S]*?`|\b(class|function|if|while|for|switch)\b|(\$|::)[\w.]+\s*(:?)=|;|,|\{|\}|\[|\])/gm;

    let match;
    const stack = []; // Pour suivre l'imbrication : { type: 'block'|'struct'|'array', startPos: number, needsSemi: boolean }

    // 'block' = function/class/if body (ne veut pas de ;)
    // 'struct' = objet JSON ou assignation var { } (veut des , et un ; final si assignation)
    // 'cmd' = bloc de commande execute { } (veut un ; final)

    while ((match = tokenRegex.exec(text)) !== null) {
        const token = match[0];
        const index = match.index;

        // Ignorer commentaires et chaînes
        if (token.startsWith('//') || token.startsWith('#') || token.startsWith('/*') || token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) {
            continue;
        }

        // 1. Mots-clés définissant un bloc qui NE DOIT PAS finir par ;
        if (['class', 'function', 'if', 'while', 'for', 'switch'].includes(token)) {
            stack.push({ type: 'definition_keyword', pos: index });
        }

        // 2. Assignations (variables) -> Doit finir par ;
        else if (token.includes('=') && (token.startsWith('$') || token.startsWith('::'))) {
            stack.push({ type: 'assignment', pos: index });
        }

        // 3. Accolade ouvrante {
        else if (token === '{') {
            let parentType = 'unknown';
            let needsSemi = false;
            let isStruct = false; // Pour vérifier les virgules

            if (stack.length > 0) {
                const last = stack[stack.length - 1];
                if (last.type === 'definition_keyword') {
                    parentType = 'definition_block'; // ex: function foo() {
                    stack.pop(); // On consomme le mot clé
                } else if (last.type === 'assignment') {
                    parentType = 'struct_block'; // ex: ::var = {
                    needsSemi = true;
                    isStruct = true;
                    stack.pop(); // On consomme l'assignation
                } else if (last.type === 'struct_block' || last.type === 'array_block') {
                    // Imbriqué dans une structure
                    parentType = 'struct_block';
                    isStruct = true;
                } else {
                    // Par défaut, un bloc isolé (ex: execute run { }) requiert un ;
                    // Sauf si c'est un bloc purement logique ? En JMC, execute run { } demande un ;
                    parentType = 'command_block';
                    needsSemi = true;
                }
            } else {
                // Bloc racine (ex: execute run { ... })
                parentType = 'command_block';
                needsSemi = true;
            }

            stack.push({ type: parentType, startPos: index, needsSemi, isStruct, lastElementEnd: null });
        }

        // 4. Crochet ouvrant [ (Pour les listes)
        else if (token === '[') {
            stack.push({ type: 'array_block', startPos: index, isStruct: true, lastElementEnd: null });
        }

        // 5. Fermetures } ou ]
        else if (token === '}' || token === ']') {
            if (stack.length === 0) continue; // Erreur de syntaxe (trop de }), géré ailleurs ou ignoré
            const currentBlock = stack.pop();

            // Vérification des virgules manquantes dans les structures multi-lignes
            if (currentBlock.isStruct && currentBlock.lastElementEnd !== null) {
                // Si on a eu un élément, qu'on ferme, et qu'il n'y a pas eu de virgule après le dernier élément
                // Ce n'est pas une erreur en JSON standard (pas de virgule trailing), 
                // mais si on a : { a:1 \n b:2 }, il faut une virgule entre 1 et b.
                // Notre logique simplifiée ici ne capture pas tout, on va se fier à la détection de virgule 'au passage'.
            }

            // Gestion du point-virgule après le bloc
            const nextCharIndex = tokenRegex.lastIndex; // Position juste après }
            // On regarde le prochain token significatif (on saute les espaces via regex exec suivant)

            // Astuce : on regarde juste après si on a un ;
            // Mais attention, la boucle principale va avancer.
            // On va vérifier "à la volée".

            if (currentBlock.needsSemi) {
                // On s'attend à un ;
                // On scanne manuellement après pour voir s'il y a un ;
                const remaining = text.slice(index + 1);
                const nextSemi = remaining.search(/\S/); // Premier char non-espace

                if (nextSemi !== -1 && remaining[nextSemi] === ';') {
                    // OK, il y a un ;
                } else {
                    // ERREUR : Manque ;
                    // Sauf si c'est à l'intérieur d'une autre structure (ex: un objet dans une liste ne prend pas de ; mais une ,)
                    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
                    const isInsideStruct = parent && (parent.type === 'struct_block' || parent.type === 'array_block');

                    if (!isInsideStruct) {
                        const pos = document.positionAt(index + 1);
                        const range = new vscode.Range(pos, pos.translate(0, 1));
                        if (!isRangeIgnored(range, ignoredZones)) {
                            diags.push(new vscode.Diagnostic(range, "Missing semicolon ';' after block/structure.", vscode.DiagnosticSeverity.Error));
                        }
                    }
                }
            } else if (currentBlock.type === 'definition_block') {
                // NE VEUT PAS DE ;
                const remaining = text.slice(index + 1);
                const nextSemi = remaining.search(/\S/);
                if (nextSemi !== -1 && remaining[nextSemi] === ';') {
                    const semiPos = document.positionAt(index + 1 + nextSemi);
                    const range = new vscode.Range(semiPos, semiPos.translate(0, 1));
                    if (!isRangeIgnored(range, ignoredZones)) {
                        diags.push(new vscode.Diagnostic(range, "Unnecessary semicolon ';' after function/class definition.", vscode.DiagnosticSeverity.Error));
                    }
                }
            }
        }

        // 6. Virgule
        else if (token === ',') {
            if (stack.length > 0) {
                const current = stack[stack.length - 1];
                if (current.isStruct) {
                    current.lastElementEnd = index; // On a vu une virgule
                }
            }
        }

        // 7. Point-virgule (Détection redondance)
        else if (token === ';') {
            // Vérifier s'il y en a un autre juste après
            const nextIdx = index + 1;
            if (text[nextIdx] === ';') {
                const pos = document.positionAt(nextIdx);
                const range = new vscode.Range(pos, pos.translate(0, 1));
                if (!isRangeIgnored(range, ignoredZones)) {
                    // Vérifier que ce n'est pas une boucle for (;;)
                    // C'est dur avec cette boucle simple, mais en JMC for(;;) est rare ou géré par for (...)
                    // On assume redondant.
                    diags.push(new vscode.Diagnostic(range, "Redundant semicolon.", vscode.DiagnosticSeverity.Error));
                }
            }
        }
    }
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

    // --- LOGIQUE : Trouver les blocs @ignore ---
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
            const ignoreZone = new vscode.Range(startPos, endPos.translate(0, ignoreEndTag.length));
            ignoredZones.push(ignoreZone);
            ignoreMarkerRanges.push(document.lineAt(startPos.line).range);
            ignoreMarkerRanges.push(document.lineAt(endPos.line).range);
            searchIndex = endSearchIndex + ignoreEndTag.length;
        } else {
            break;
        }
    }

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

    // --- MODIFICATION IMPORTANTE : Utiliser la variable globale sans 'const' ---
    definedFunctionsInDoc = getDefinedFunctionsFromText(text.replace(/(\/\/|#).*/g, ''));

    // Analyse principale des blocs de code
    processCodeBlock(text, 0, 0, diags, jmcFunctions);

    const localDefinedNames = definedFunctionsInDoc.map(d => d.split('.').pop());
    const globalDefinedNames = [...globalDefinedFunctions].map(f => f.split('.').pop());
    const allDefinedFunctionNames = new Set([...localDefinedNames, ...globalDefinedNames]);

    const simpleUsed = new Set([...globalUsedFunctions].map(f => f.split('.').pop()));

    const addDecoratedFunctions = new Set();
    const functionWithAddDecoratorRegex = /@add\s*(?:\([^)]*\))?\s*function\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    let addMatch;
    while ((addMatch = functionWithAddDecoratorRegex.exec(text)) !== null) {
        addDecoratedFunctions.add(addMatch[1]);
    }

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

    validateSemicolonsAndStructures(document, diags, ignoredZones);

    // --- DÉBUT NOUVELLE LOGIQUE STORAGE (Déplacé ICI avant le filtrage final) ---
    const storageOpRegex = /(:[-+\*\/%]?=)/g;
    // Capture "namespace::var" ou "::var"
    const storageVarRegex = /([a-zA-Z0-9_.]*::[a-zA-Z0-9_.]+)/g;

    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        const lineText = line.text;

        const commentIndex = Math.min(
            lineText.indexOf('//') === -1 ? Infinity : lineText.indexOf('//'),
            lineText.indexOf('#') === -1 ? Infinity : lineText.indexOf('#')
        );
        const codeText = commentIndex !== Infinity ? lineText.substring(0, commentIndex) : lineText;

        let opMatch;
        storageOpRegex.lastIndex = 0;

        while ((opMatch = storageOpRegex.exec(codeText)) !== null) {
            const opIndex = opMatch.index;
            const opLength = opMatch[0].length;
            const rhsStart = opIndex + opLength;
            const rhsText = codeText.substring(rhsStart);

            let varMatch;
            storageVarRegex.lastIndex = 0;

            while ((varMatch = storageVarRegex.exec(rhsText)) !== null) {
                const varName = varMatch[0];
                const varIndexInRhs = varMatch.index;
                const absoluteVarIndex = rhsStart + varIndexInRhs;

                const textBefore = codeText.substring(0, absoluteVarIndex).trimEnd();
                const textAfter = codeText.substring(absoluteVarIndex + varName.length).trimStart();

                const hasOpenBrace = textBefore.endsWith('{');
                const hasCloseBrace = textAfter.startsWith('}');

                if (!hasOpenBrace || !hasCloseBrace) {
                    const startPos = new vscode.Position(i, absoluteVarIndex);
                    const endPos = new vscode.Position(i, absoluteVarIndex + varName.length);
                    const range = new vscode.Range(startPos, endPos);

                    if (!isRangeIgnored(range, ignoredZones)) {
                        diags.push(new vscode.Diagnostic(
                            range,
                            `Storage variable '${varName}' must be wrapped in curly braces {} when using the '${opMatch[0]}' operator.\nCorrect usage: {${varName}}`,
                            vscode.DiagnosticSeverity.Error
                        ));
                    }
                }
            }
        }
    }
    // --- FIN NOUVELLE LOGIQUE STORAGE ---
    processCodeBlock(text, 0, 0, diags, Object.keys(moduleSnippets));
    // Filtrer les résultats qui sont dans une zone ignorée
    const finalDiags = diags.filter(d => !isRangeIgnored(d.range, ignoredZones));
    const finalFadeRanges = fadeRanges.filter(r => !isRangeIgnored(r, ignoredZones));
    const finalUnusedRanges = unusedRanges.filter(r => !isRangeIgnored(r, ignoredZones));

    diagnostics.set(document.uri, finalDiags);
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === document) {
        editor.setDecorations(decoratorDecoration, decoratorRanges);
        editor.setDecorations(fadeDecoration, finalFadeRanges);
        editor.setDecorations(unusedDecoration, finalUnusedRanges);
        editor.setDecorations(ignoreDecoration, ignoreMarkerRanges);
        editor.setDecorations(ignoreContentDecoration, ignoredZones);
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

    let sanitizedBlockText = blockText.split('');
    for (const block of subBlocks) {
        for (let i = block.start + 1; i < block.end - 1; i++) {
            if (sanitizedBlockText[i] !== '\n') {
                sanitizedBlockText[i] = ' ';
            }
        }
    }
    sanitizedBlockText = sanitizedBlockText.join('');

    const lines = sanitizedBlockText.split('\n');
    let parenDepth = 0;

    for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        const currentLineNumber = baseLine + i;
        const currentOffset = (i === 0) ? baseOffset : 0;

        const commentIndex = Math.min(...['//', '#'].map(sym => { const idx = lineText.indexOf(sym); return idx === -1 ? Infinity : idx; }));
        const lineContent = (commentIndex === Infinity ? lineText : lineText.substring(0, commentIndex));

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

                const isDecoratorLine = /^\s*@\w+(\([^)]*\))?\s*$/.test(trimmedSegment);
                if (isDecoratorLine) {
                    segmentOffset += segment.length;
                    continue;
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
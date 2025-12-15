const fs = require('fs');
const path = require('path');

// --- Regex de base ---
const functionRegex = /function\s+([a-zA-Z0-9_.]*)\s*\(/g;
const classRegex = /class\s+([a-zA-Z0-9_]*)/g;
const variableRegex = /(\$|::)([a-zA-Z0-9_.]*)/g;
const importRegex = /^\s*import\s+"([^"]+)"/gm;

// --- Fonctions existantes conservées pour le Linter ---

function getDefinedFunctionsFromText(text) {
    return [...text.matchAll(functionRegex)].map(m => m[1]);
}

function getAllCallIdentifiers(text) {
    return [...text.matchAll(/\b(?:[a-zA-Z_][\w.]*\.)*[a-zA-Z_][\w.]*\s*\(/g)]
        .filter(m => !/function\s*$/.test(text.slice(0, m.index)))
        .map(m => m[0].replace(/\s*\($/, ''));
}

function extractVariables(text) {
    const normal = [...new Set([...text.matchAll(/\$([a-zA-Z_][\w.]*)/g)].map(m => m[1]))];
    const storage = [...new Set([...text.matchAll(/::([a-zA-Z_][\w.]*)/g)].map(m => m[1]))];
    return { normal, storage };
}

function parseFunctionsAndClasses(text) {
    // Cette version locale est gardée pour compatibilité si besoin,
    // mais getGlobalScope fait mieux pour l'analyse globale.
    const lines = text.split('\n');
    const classMap = new Map();
    const functionMap = new Map();

    const classDefRegex = /^\s*(?:@(\w+)\s+)?class\s+([a-zA-Z_]\w*)/;
    const funcDefRegex = /^\s*(?:@([a-zA-Z_-]+(?:\([^)]*\))?)\s+)?function\s+([\w.]+)\s*\(/;

    let currentClass = null;
    let commentBlock = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//')) {
            commentBlock.push(trimmed.slice(2).trim());
            continue;
        }

        const classMatch = line.match(classDefRegex);
        if (classMatch) {
            currentClass = classMatch[2];
            classMap.set(currentClass, { functions: [] });
            commentBlock = [];
            continue;
        }

        const functionMatch = line.match(funcDefRegex);
        if (functionMatch) {
            const functionName = functionMatch[2];
            const descriptionLines = [];
            let inDesc = false;

            for (const l of commentBlock) {
                if (l.startsWith('@description')) {
                    descriptionLines.push(l.replace('@description', '').trim());
                    inDesc = true;
                } else if (inDesc) {
                    descriptionLines.push(l);
                }
            }

            const description = descriptionLines.join('\n').trim();
            functionMap.set(functionName, {
                inClass: currentClass,
                description
            });
        }

        if (trimmed !== '') {
            commentBlock = [];
        }
    }

    return { classMap, functionMap };
}

// --- Nouvelle Logique Récursive pour Providers ---

/**
 * Analyse récursivement tous les fichiers liés pour trouver fonctions, classes et variables.
 * @param {string} rootPath Racine du workspace
 * @param {vscode.TextDocument} currentDoc Document en cours (point de départ)
 */
function getGlobalScope(rootPath, currentDoc) {
    const visited = new Set();
    const functions = new Map(); // Key: name, Value: { filePath, line, doc }
    const classes = new Map();
    const variables = new Set();

    // Fonction de parcours
    function traverse(filePath, contentOverride = null) {
        const normPath = path.resolve(filePath).toLowerCase();
        if (visited.has(normPath)) return;
        visited.add(normPath);

        let content = contentOverride;
        if (content === null) {
            try {
                if (fs.existsSync(filePath)) {
                    content = fs.readFileSync(filePath, 'utf8');
                } else {
                    return;
                }
            } catch (e) { return; }
        }

        const cleanContent = content.replace(/(\/\/|#).*/g, '');

        // 1. Extraire Fonctions
        let match;
        // On reset le regex global avant usage
        functionRegex.lastIndex = 0;
        while ((match = functionRegex.exec(cleanContent)) !== null) {
            const name = match[1];
            const linesUpTo = content.substring(0, match.index).split('\n');
            const lineNum = linesUpTo.length - 1;
            functions.set(name, {
                name: name,
                filePath: filePath,
                line: lineNum
            });
        }

        // 2. Extraire Classes
        classRegex.lastIndex = 0;
        while ((match = classRegex.exec(cleanContent)) !== null) {
            const name = match[1];
            const linesUpTo = content.substring(0, match.index).split('\n');
            classes.set(name, {
                name: name,
                filePath: filePath,
                line: linesUpTo.length - 1
            });
        }

        // 3. Extraire Variables
        variableRegex.lastIndex = 0;
        while ((match = variableRegex.exec(cleanContent)) !== null) {
            variables.add(match[0]);
        }

        // 4. Gérer les IMPORTS (Récursion)
        importRegex.lastIndex = 0;
        const fileDir = path.dirname(filePath);

        while ((match = importRegex.exec(content)) !== null) {
            const importStr = match[1];
            let targets = [];

            if (importStr.endsWith('/*')) {
                const relDir = importStr.slice(0, -2);
                const absDir = path.resolve(fileDir, relDir);
                if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
                    try {
                        const files = fs.readdirSync(absDir);
                        files.forEach(f => {
                            if (f.endsWith('.jmc')) targets.push(path.join(absDir, f));
                        });
                    } catch (e) { }
                }
            } else if (importStr === '*') {
                try {
                    const files = fs.readdirSync(rootPath);
                    files.forEach(f => {
                        if (f.endsWith('.jmc')) targets.push(path.join(rootPath, f));
                    });
                } catch (e) { }
            } else {
                let targetPath = importStr;
                if (!targetPath.endsWith('.jmc')) targetPath += '.jmc';
                targets.push(path.resolve(fileDir, targetPath));
            }

            targets.forEach(t => traverse(t));
        }
    }

    // Point d'entrée
    if (currentDoc) {
        traverse(currentDoc.uri.fsPath, currentDoc.getText());
    } else {
        traverse(path.join(rootPath, 'main.jmc'));
    }

    return { functions, classes, variables };
}

// --- Helpers pour Snippets ---

// Nettoie le corps du snippet pour obtenir une signature lisible
function getSignatureFromSnippet(snippetBody) {
    const bodyStr = Array.isArray(snippetBody) ? snippetBody.join('\n') : snippetBody;
    // Remplace ${1:texte} par texte et ${1} par rien ou placeholder
    return bodyStr.replace(/\$\{\d+:([^}]+)\}/g, '$1').replace(/\$\d+/g, '');
}

// Extrait la liste des paramètres depuis une signature propre
function getParamsFromSignature(signature) {
    const match = signature.match(/\(([\s\S]*)\)/);
    if (!match || !match[1].trim()) return [];
    return match[1].split(',')
        .map(p => p.trim())
        .filter(Boolean);
}

module.exports = {
    getDefinedFunctionsFromText,
    getAllCallIdentifiers,
    extractVariables,
    parseFunctionsAndClasses,
    getGlobalScope,
    getSignatureFromSnippet,
    getParamsFromSignature
};
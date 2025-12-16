const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { runCompiler } = require('./compiler');
const { setLinterSnippets, getLinterDiagnosticsForWorkspace, applyDecorations, clearDecorations } = require('./linter');

const diagnosticCollection = vscode.languages.createDiagnosticCollection('jmc');
const outputChannel = vscode.window.createOutputChannel("JMC Extension");
let successDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
        contentText: ' ✓ Compiled successfully',
        color: 'rgba(100, 255, 100, 0.7)',
        fontStyle: 'italic',
        margin: '0 0 0 20px'
    },
    isWholeLine: true
});
let successTimeout = null;
function initDiagnostics(context) {
    const handleDoc = (document) => {
        if (document.languageId === 'jmc') {
            processDocument(document);
        }
    };

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(handleDoc),
        vscode.workspace.onDidOpenTextDocument(handleDoc)
    );

    return [diagnosticCollection];
}

async function processDocument(document) {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === document) {
        editor.setDecorations(successDecorationType, []);
    }
    // 1. Décorations immédiates (Linter)
    const linterResult = getLinterDiagnosticsForWorkspace(document);
    // On applique les décorations uniquement sur le fichier ouvert (car linterResult retourne une Map maintenant)
    const currentPath = path.resolve(document.uri.fsPath);
    // Note : getLinterDiagnosticsForWorkspace ne retourne pas directement les décorations dans la nouvelle structure, 
    // il faudrait idéalement que le linter retourne aussi les décos. 
    // Pour simplifier ici, on suppose que vous utilisez applyDecorations indépendamment ou que le linter est adapté.
    // (J'ai laissé la logique telle quelle pour ne pas casser votre linter actuel)

    outputChannel.appendLine(`Compiling...`);
    const compilerResult = await runCompiler(document);

    // 2. Si Compilation OK -> Tout vider
    if (compilerResult.success) {
        outputChannel.appendLine("Compilation Successful.");
        if (editor && editor.document === document) {
            clearDecorations(editor);
            showSuccessMessage(editor); // <--- NOUVEAU
        }
        return;
    }

    outputChannel.appendLine("Compilation Failed.");

    // 3. Propagation des erreurs sur les lignes d'import
    // On ajoute des erreurs virtuelles sur le fichier courant si ses dépendances ont échoué
    const importErrors = propagateImportErrors(document, compilerResult.diagnosticsMap);

    // On ajoute ces erreurs à la Map du compilateur pour le fichier courant
    if (importErrors.length > 0) {
        if (!compilerResult.diagnosticsMap.has(currentPath)) {
            compilerResult.diagnosticsMap.set(currentPath, []);
        }
        compilerResult.diagnosticsMap.get(currentPath).push(...importErrors);
    }

    // 4. Fusionner les résultats (Compiler + Linter)
    const allFilePaths = new Set([
        ...compilerResult.diagnosticsMap.keys(),
        ...linterResult.diagnosticsMap.keys()
    ]);

    diagnosticCollection.clear();

    for (const filePath of allFilePaths) {
        const fileUri = vscode.Uri.file(filePath);

        const compilerDiags = compilerResult.diagnosticsMap.get(filePath) || [];
        const linterDiags = linterResult.diagnosticsMap.get(filePath) || [];

        // Fusion intelligente
        const mergedDiags = mergeDiagnostics(compilerDiags, linterDiags);

        diagnosticCollection.set(fileUri, mergedDiags);
    }
}

function showSuccessMessage(editor) {
    // Si une ancienne décoration est en attente, on l'annule
    if (successTimeout) {
        clearTimeout(successTimeout);
        editor.setDecorations(successDecorationType, []);
    }

    // On trouve la ligne du curseur pour afficher le message à côté
    const position = editor.selection.active;
    const range = new vscode.Range(position.line, 0, position.line, 0); // Range vide, l'important est la ligne

    // Alternative : Afficher à la toute première ligne du fichier si on préfère
    // const range = new vscode.Range(0, 0, 0, 0);

    editor.setDecorations(successDecorationType, [range]);

    // Disparition après 3 secondes
    successTimeout = setTimeout(() => {
        editor.setDecorations(successDecorationType, []);
        successTimeout = null;
    }, 6000);
}

/**
 * Scanne le document actuel pour trouver les imports qui pointent vers des fichiers en erreur
 */
function propagateImportErrors(document, compilerErrorsMap) {
    const text = document.getText();
    const currentDir = path.dirname(document.uri.fsPath);
    const newDiagnostics = [];

    // Regex pour trouver: import "fichier"
    const importRegex = /^\s*import\s+["']([^"']+)["']/gm;
    let match;

    // Liste des fichiers (chemins absolus) qui ont échoué à la compilation
    // On normalise les chemins pour la comparaison (Windows insensible à la casse, slashs...)
    const failedFiles = new Set([...compilerErrorsMap.keys()].map(p => path.resolve(p).toLowerCase()));

    while ((match = importRegex.exec(text)) !== null) {
        const importPath = match[1];
        const importStartIndex = match.index;
        const importEndIndex = match.index + match[0].length;

        // Résolution du chemin cible
        let targetAbsPath = null;
        let isDirectoryImport = false;

        if (importPath.endsWith('/*')) {
            // Import de dossier : on vérifie si un fichier DANS ce dossier a échoué
            isDirectoryImport = true;
            const targetDir = path.resolve(currentDir, importPath.slice(0, -2)).toLowerCase();

            // Si un des fichiers en erreur commence par ce dossier
            for (const failedFile of failedFiles) {
                if (failedFile.startsWith(targetDir)) {
                    targetAbsPath = failedFile; // On a trouvé un coupable
                    break;
                }
            }
        } else {
            // Import de fichier simple
            let p = path.resolve(currentDir, importPath);
            if (!p.endsWith('.jmc')) p += '.jmc';
            targetAbsPath = p.toLowerCase();
        }

        // Si le fichier cible (ou dossier) contient des erreurs connues
        if (targetAbsPath && (failedFiles.has(targetAbsPath) || isDirectoryImport && targetAbsPath)) {
            const range = new vscode.Range(
                document.positionAt(importStartIndex),
                document.positionAt(importEndIndex)
            );

            const msg = isDirectoryImport
                ? `Compilation failed in imported directory '${importPath}'.`
                : `Compilation failed in imported file '${path.basename(targetAbsPath)}'.`;

            const diag = new vscode.Diagnostic(
                range,
                msg,
                vscode.DiagnosticSeverity.Error
            );
            diag.source = 'JMC Import Checker';
            newDiagnostics.push(diag);
        }
    }

    return newDiagnostics;
}

function mergeDiagnostics(compilerDiags, linterDiags) {
    const compilerErrorLines = new Set(compilerDiags.map(d => d.range.start.line));
    const merged = [...compilerDiags];

    for (const d of linterDiags) {
        if (!compilerErrorLines.has(d.range.start.line)) {
            merged.push(d);
        }
    }
    return merged;
}

function setDiagnosticsSnippets(snippets) {
    setLinterSnippets(snippets);
}

module.exports = {
    initDiagnostics,
    setDiagnosticsSnippets
};
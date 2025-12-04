const vscode = require('vscode');
const path = require('path');
const { runCompiler } = require('./compiler');
const { setLinterSnippets, getLinterDiagnostics, applyDecorations, clearDecorations } = require('./linter');

const diagnosticCollection = vscode.languages.createDiagnosticCollection('jmc');
const outputChannel = vscode.window.createOutputChannel("JMC Extension");

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
    // On peut lancer le linter tout de suite pour les décorations (couleurs)
    const linterResult = getLinterDiagnostics(document);
    if (editor && editor.document === document) {
        applyDecorations(editor, linterResult.decorations);
    }

    // Lancer le compilateur
    outputChannel.appendLine(`Compiling ${path.basename(document.fileName)}...`);
    const compilerResult = await runCompiler(document);

    if (compilerResult.success) {
        // --- CAS SUCCES ---
        outputChannel.appendLine("Compilation Successful.");
        // Si tout est bon, on efface tout.
        // NOTE: On peut choisir de laisser les Warnings du linter ici si on veut.
        // Pour l'instant, on respecte la consigne "désactiver le linter si compile ok" (pour les erreurs).
        diagnosticCollection.clear();
        return;
    }

    // --- CAS ECHEC ---
    outputChannel.appendLine("Compilation Failed.");

    // 1. Erreurs du compilateur pour CE fichier
    const currentPath = path.resolve(document.uri.fsPath);
    const compilerDiags = compilerResult.diagnostics.filter(d => d.relatedFilePath === currentPath);

    // 2. Erreurs du linter
    // On ajoute les erreurs du linter uniquement si elles ne sont pas sur la même ligne qu'une erreur du compilateur
    // (Le compilateur a souvent raison sur la cause profonde)
    const compilerErrorLines = new Set(compilerDiags.map(d => d.range.start.line));
    const mergedDiags = [...compilerDiags];

    for (const d of linterResult.diagnostics) {
        if (!compilerErrorLines.has(d.range.start.line)) {
            mergedDiags.push(d);
        }
    }

    diagnosticCollection.set(document.uri, mergedDiags);
}

function setDiagnosticsSnippets(snippets) {
    setLinterSnippets(snippets);
}

module.exports = {
    initDiagnostics,
    setDiagnosticsSnippets
};
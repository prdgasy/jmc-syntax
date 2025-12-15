const vscode = require('vscode');
const path = require('path');
const { runCompiler } = require('./compiler');
const { setLinterSnippets, getLinterDiagnosticsForWorkspace } = require('./linter');

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
    outputChannel.appendLine(`Compiling...`);
    const compilerResult = await runCompiler(document);

    // 1. Si Compilation OK -> Tout vider
    if (compilerResult.success) {
        outputChannel.appendLine("Compilation Success.");
        diagnosticCollection.clear();
        return;
    }

    outputChannel.appendLine("Compilation Failed.");

    // 2. Lancer le Linter Global
    // Cela retourne une Map<FilePath, Diagnostics[]>
    const linterResult = getLinterDiagnosticsForWorkspace(document);

    // 3. Fusionner les résultats
    const allFilePaths = new Set([
        ...compilerResult.diagnosticsMap.keys(),
        ...linterResult.diagnosticsMap.keys()
    ]);

    diagnosticCollection.clear(); // Nettoyer avant d'afficher

    for (const filePath of allFilePaths) {
        const fileUri = vscode.Uri.file(filePath);

        const compilerDiags = compilerResult.diagnosticsMap.get(filePath) || [];
        const linterDiags = linterResult.diagnosticsMap.get(filePath) || [];

        // Fusion intelligente (ne pas dupliquer les lignes)
        const mergedDiags = mergeDiagnostics(compilerDiags, linterDiags);

        diagnosticCollection.set(fileUri, mergedDiags);
    }
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
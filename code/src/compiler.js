const cp = require('child_process');
const vscode = require('vscode');
const path = require('path');

// Regex pour nettoyer les codes couleurs ANSI
const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function runCompiler(document) {
    return new Promise((resolve) => {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) {
            resolve({ success: false, diagnostics: [] });
            return;
        }

        const cwd = workspaceFolder.uri.fsPath;
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        const command = `${pythonCmd} -m jmc compile`;

        cp.exec(command, { cwd: cwd }, (err, stdout, stderr) => {
            // 1. Récupération et nettoyage de la sortie
            const rawOutput = (stdout || "") + "\n" + (stderr || "");
            const cleanOutput = rawOutput.replace(ansiRegex, '');

            const isSuccess = cleanOutput.includes('Compiled successfully');
            let diagnostics = [];

            // 2. Détection du CRASH / AssertionError
            // JMC affiche souvent "Unexpected error causes program to crash" suivi d'une stacktrace Python
            if (cleanOutput.includes('Unexpected error causes program to crash') || cleanOutput.includes('AssertionError')) {

                // Calculer la position de la dernière ligne pour placer l'erreur
                const lastLineIndex = Math.max(0, document.lineCount - 1);
                let lastLineLength = 0;
                try {
                    lastLineLength = document.lineAt(lastLineIndex).text.length;
                } catch (e) {
                    // Fallback si le document est vide ou inaccessible
                    lastLineLength = 1;
                }

                const range = new vscode.Range(
                    lastLineIndex,
                    0,
                    lastLineIndex,
                    lastLineLength
                );

                const crashDiag = new vscode.Diagnostic(
                    range,
                    "JMC Compiler Crash: An unexpected error occurred in the compiler (AssertionError).\nCheck your syntax closely, specifically macros, variables, or recently added code.",
                    vscode.DiagnosticSeverity.Error
                );

                crashDiag.source = 'JMC Compiler';

                // --- CRUCIAL : Associer l'erreur au fichier courant ---
                // Sans ça, diagnostics.js filtre l'erreur et ne l'affiche pas
                crashDiag.relatedFilePath = path.resolve(document.uri.fsPath);

                diagnostics.push(crashDiag);
            }

            // 3. Parsing des erreurs standards (si présentes en plus du crash ou au lieu du crash)
            const standardDiagnostics = parseCompilerOutput(cleanOutput, cwd);
            diagnostics = diagnostics.concat(standardDiagnostics);

            // 4. Résolution de la promesse (IMPORTANT : Toujours résoudre)
            resolve({
                success: isSuccess,
                diagnostics: diagnostics
            });
        });
    });
}

function parseCompilerOutput(output, rootPath) {
    const lines = output.split(/\r?\n/);
    const diags = [];

    // Regex "In file:line:col"
    const locationRegex = /^\s*In\s+(.+?):(\d+):(\d+)/;
    const caretRegex = /^(\s*)(\^+)/;
    const codeLineRegex = /^\s*\d+\s*\|/;

    let currentFile = null;
    let currentRange = null;
    let currentMessage = [];

    const pushDiag = () => {
        if (currentFile && currentRange && currentMessage.length > 0) {
            const msg = currentMessage.join('\n').trim();
            if (msg) {
                const d = new vscode.Diagnostic(currentRange, msg, vscode.DiagnosticSeverity.Error);
                d.source = 'JMC Compiler';
                // On attache le chemin fichier à l'objet diagnostic pour le tri dans diagnostics.js
                d.relatedFilePath = currentFile;
                diags.push(d);
            }
        }
        currentMessage = [];
    };

    for (const line of lines) {
        // 1. Détection Fichier
        const locMatch = line.match(locationRegex);
        if (locMatch) {
            pushDiag();
            currentFile = path.resolve(rootPath, locMatch[1].trim());

            const lineNum = parseInt(locMatch[2]) - 1;
            const colNum = parseInt(locMatch[3]) - 1;

            currentRange = new vscode.Range(lineNum, colNum, lineNum, colNum + 1);
            continue;
        }

        if (!currentFile) continue;

        // 2. Détection Caret (^^^)
        const caretMatch = line.match(caretRegex);
        if (caretMatch && !codeLineRegex.test(line)) {
            if (currentRange) {
                currentRange = new vscode.Range(
                    currentRange.start.line,
                    currentRange.start.character,
                    currentRange.start.line,
                    currentRange.start.character + caretMatch[2].length
                );
            }
            continue;
        }

        // 3. Ignorer contexte
        if (codeLineRegex.test(line)) continue;
        if (line.trim() === '' || line.includes('Compiling...')) continue;

        currentMessage.push(line.trim());
    }
    pushDiag();

    return diags;
}

module.exports = { runCompiler };
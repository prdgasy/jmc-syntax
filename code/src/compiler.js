const cp = require('child_process');
const vscode = require('vscode');
const path = require('path');

const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function runCompiler(document) {
    return new Promise((resolve) => {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        // On retourne une Map vide en cas d'échec initial
        if (!workspaceFolder) {
            resolve({ success: false, diagnosticsMap: new Map() });
            return;
        }

        const cwd = workspaceFolder.uri.fsPath;
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        const command = `${pythonCmd} -m jmc compile`;

        cp.exec(command, { cwd: cwd }, (err, stdout, stderr) => {
            const rawOutput = (stdout || "") + "\n" + (stderr || "");
            const cleanOutput = rawOutput.replace(ansiRegex, '');

            const isSuccess = cleanOutput.includes('Compiled successfully');

            // Map<FilePath, Diagnostic[]>
            let diagnosticsMap = new Map();

            if (!isSuccess) {
                // 1. Crashs
                if (cleanOutput.includes('Unexpected error causes program to crash') || cleanOutput.includes('AssertionError')) {
                    addDiagnosticToMap(diagnosticsMap, document.uri.fsPath,
                        createGenericError(document, "JMC Compiler Crash (AssertionError).", cleanOutput)
                    );
                }
                // 2. Erreur Syntaxique ou Import
                else {
                    diagnosticsMap = parseCompilerOutput(cleanOutput, cwd);

                    // Fallback: Si erreur détectée mais rien de parsé, on met sur le fichier courant
                    if (diagnosticsMap.size === 0) {
                        addDiagnosticToMap(diagnosticsMap, document.uri.fsPath,
                            createGenericError(document, "Compilation Failed: Unknown Error.", cleanOutput)
                        );
                    }
                }
            }

            resolve({ success: isSuccess, diagnosticsMap: diagnosticsMap });
        });
    });
}

// Helper pour ajouter à la Map
function addDiagnosticToMap(map, filePath, diagnostic) {
    const absPath = path.resolve(filePath); // Normaliser
    if (!map.has(absPath)) {
        map.set(absPath, []);
    }
    map.get(absPath).push(diagnostic);
}

function createGenericError(document, title, detail) {
    const lastLineIndex = Math.max(0, document.lineCount - 1);
    const range = new vscode.Range(lastLineIndex, 0, lastLineIndex, 999);
    const diag = new vscode.Diagnostic(range, `${title}\n\n${detail.trim()}`, vscode.DiagnosticSeverity.Error);
    diag.source = 'JMC Compiler';
    return diag;
}

/**
 * Parse la sortie et groupe les erreurs par fichier
 */
function parseCompilerOutput(output, rootPath) {
    const lines = output.split(/\r?\n/);
    const map = new Map(); // Map<string, Diagnostic[]>

    const locationRegex = /^\s*In\s+(.+?):(\d+)(?::(\d+))?/;
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
                addDiagnosticToMap(map, currentFile, d);
            }
        }
        currentMessage = [];
    };

    for (const line of lines) {

        const locMatch = line.match(locationRegex);
        if (locMatch) {
            pushDiag();
            currentFile = path.resolve(rootPath, locMatch[1].trim());
            const lineNum = parseInt(locMatch[2]) - 1;
            // Si pas de colonne, on met 0 par défaut
            const colNum = locMatch[3] ? parseInt(locMatch[3]) - 1 : 0;

            // Si pas de colonne, on souligne toute la ligne (longueur arbitraire 999 ou fin de ligne)
            const length = locMatch[3] ? 1 : 999;
            currentRange = new vscode.Range(lineNum, colNum, lineNum, colNum + length);
            continue;
        }

        if (!currentFile) continue;

        // Gestion caret (soulignement ^^^)
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

        if (codeLineRegex.test(line)) continue;
        if (line.trim() === '' || line.includes('Compiling...')) continue;

        currentMessage.push(line.trim());
    }
    pushDiag();

    return map;
}

module.exports = { runCompiler };
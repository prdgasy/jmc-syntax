const cp = require('child_process');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

// Fonction pour trouver la racine du projet JMC (dossier contenant jmc_config.json)
function findJmcProjectRoot(startPath) {
    let currentDir = startPath;
    const { root } = path.parse(startPath);

    while (currentDir && currentDir !== root) {
        const configPath = path.join(currentDir, 'jmc_config.json');
        if (fs.existsSync(configPath)) {
            return currentDir;
        }
        currentDir = path.dirname(currentDir);
    }
    // Si non trouvé, on retourne le dossier de départ (fallback)
    return startPath;
}

function runCompiler(document) {
    return new Promise((resolve) => {
        // On ne se base plus uniquement sur le workspace folder de VSCode,
        // mais sur la position du fichier jmc_config.json
        const fileDir = path.dirname(document.uri.fsPath);
        const jmcRootPath = findJmcProjectRoot(fileDir);

        // Si aucun config file n'est trouvé, on tente quand même le workspace
        // Mais si on a trouvé un jmc_config.json, c'est ce dossier qui devient le CWD.
        const cwd = jmcRootPath;

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
                // 2. Erreur de Configuration (Nouveau cas spécifique)
                else if (cleanOutput.includes('Configuration file does not exist') || cleanOutput.includes('jmc_config.json not found')) {
                    // On affiche une erreur explicite à la fin du fichier
                    const msg = "JMC Configuration Error: 'jmc_config.json' not found in project hierarchy.\nPlease create a jmc_config.json file or open the correct folder.";
                    addDiagnosticToMap(diagnosticsMap, document.uri.fsPath,
                        createGenericError(document, "Missing Configuration", msg)
                    );
                }
                // 3. Erreur Syntaxique ou Import
                else {
                    // On passe le cwd (jmcRootPath) à parseCompilerOutput pour qu'il résolve correctement les chemins relatifs
                    diagnosticsMap = parseCompilerOutput(cleanOutput, cwd);

                    // Fallback
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
    const absPath = path.resolve(filePath);
    if (!map.has(absPath)) {
        map.set(absPath, []);
    }
    map.get(absPath).push(diagnostic);
}

function createGenericError(document, title, detail) {
    const lastLineIndex = Math.max(0, document.lineCount - 1);
    let lastLineLength = 0;
    try { lastLineLength = document.lineAt(lastLineIndex).text.length; } catch (e) { lastLineLength = 1; }

    const range = new vscode.Range(lastLineIndex, 0, lastLineIndex, lastLineLength);
    const diag = new vscode.Diagnostic(range, `${title}\n\n${detail.trim()}`, vscode.DiagnosticSeverity.Error);
    diag.source = 'JMC Compiler';
    return diag;
}

/**
 * Parse la sortie et groupe les erreurs par fichier
 */
function parseCompilerOutput(output, rootPath) {
    const lines = output.split(/\r?\n/);
    const map = new Map();

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
            // Résolution par rapport au rootPath trouvé (là où est jmc_config.json)
            currentFile = path.resolve(rootPath, locMatch[1].trim());

            const lineNum = parseInt(locMatch[2]) - 1;
            const colNum = locMatch[3] ? parseInt(locMatch[3]) - 1 : 0;
            const length = locMatch[3] ? 1 : 999;

            currentRange = new vscode.Range(lineNum, colNum, lineNum, colNum + length);
            continue;
        }

        if (!currentFile) continue;

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
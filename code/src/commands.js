// src/commands.js
const vscode = require('vscode');

function initCommands(context) {
    const compileCommand = vscode.commands.registerCommand('jmc.compile', () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }

        const folder = workspaceFolders[0].uri.fsPath;
        let terminal = vscode.window.terminals.find(t => t.name === "JMC Compiler");

        if (!terminal) {
            terminal = vscode.window.createTerminal({ name: "JMC Compiler", cwd: folder });
            terminal.sendText("python -m jmc", true);
        }
        terminal.sendText("compile", true);
        terminal.show(true);
    });

    // Retourne un tableau de tous les disposables créés dans ce module
    return [compileCommand];
}

module.exports = { initCommands };
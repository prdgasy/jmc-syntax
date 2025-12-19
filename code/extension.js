const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const { initCommands } = require('./src/commands');
const { initDiagnostics, setDiagnosticsSnippets } = require('./src/diagnostics');
const { registerFormatter } = require('./src/formatter');
const { initProviders } = require('./src/providers');

function activate(context) {
    console.log('JMC extension active.');

    let snippets = {};
    const snippetsPath = path.join(context.extensionPath, 'snippets', 'jmc.code-snippets');
    try {
        const data = fs.readFileSync(snippetsPath, 'utf8');
        snippets = JSON.parse(data);
    } catch (e) {
        console.error('Failed snippets:', e);
    }

    setDiagnosticsSnippets(snippets); // Envoyer les snippets au linter via le diagnostic controller

    context.subscriptions.push(
        ...initCommands(context),
        ...initDiagnostics(context),
        registerFormatter(),
        ...initProviders(context, snippets)
    );
}

function deactivate() { }

module.exports = { activate, deactivate };
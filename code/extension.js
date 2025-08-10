// extension.js
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// Import des modules séparés
const { initCommands } = require('./src/commands');
// --- MODIFICATION ICI ---
const { initDiagnostics, setDiagnosticsSnippets } = require('./src/diagnostics');
// --- FIN DE LA MODIFICATION ---
const { registerFormatter } = require('./src/formatter');
const { initProviders } = require('./src/providers');

function activate(context) {
    console.log('JMC extension is now active.');

    let snippets = {};
    const snippetsPath = path.join(context.extensionPath, 'snippets', 'jmc.code-snippets');
    try {
        const data = fs.readFileSync(snippetsPath, 'utf8');
        snippets = JSON.parse(data);
    } catch (e) {
        console.error('Failed to load JMC snippets:', e);
    }

    // --- MODIFICATIONS ICI ---
    // 1. Passer les snippets au module de diagnostic
    setDiagnosticsSnippets(snippets);

    // 2. Initialiser les modules sans passer les snippets directement à initDiagnostics
    const commandDisposables = initCommands(context);
    const diagnosticDisposables = initDiagnostics(context); // L'argument 'snippets' est retiré
    // --- FIN DES MODIFICATIONS ---
    const formatterDisposable = registerFormatter();
    const providerDisposables = initProviders(context, snippets);

    context.subscriptions.push(
        ...commandDisposables,
        ...diagnosticDisposables,
        formatterDisposable,
        ...providerDisposables
    );

    // Le premier déclenchement se fait maintenant à l'intérieur de initDiagnostics,
    // donc plus besoin de le faire ici.
}

function deactivate() { }

module.exports = {
    activate,
    deactivate
};
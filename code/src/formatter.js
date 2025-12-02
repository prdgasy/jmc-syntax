// src/formatter.js
const vscode = require('vscode');

function registerFormatter() {
    return vscode.languages.registerDocumentFormattingEditProvider('jmc', {
        provideDocumentFormattingEdits(document) {
            let originalText = document.getText();
            const strings = [];
            const stringRegex = /"([^"\\]*(\\.[^"\\]*)*)"|'([^'\\]*(\\.[^'\\]*)*)'|`([\s\S]*?)`/g;

            let text = originalText.replace(stringRegex, (match) => {
                const token = `__STR_${strings.length}__`;
                strings.push(match);
                return token;
            });

            // 1. Gérer les sauts de ligne
            text = text.replace(/(\{)(\s*)(\S)(.*?)(\r?\n|$)/g, (match, openBrace, whitespace, content, rest, eol) => {
                if (rest.includes('}')) return match;
                return `${openBrace}\n${content}${rest}${eol}`;
            });
            text = text.replace(/(\r?\n|^)(.*?)(\S)(\s*)(\})/g, (match, eol, preceding, content, whitespace, closeBrace) => {
                if (preceding.includes('{')) return match;
                return `${eol}${preceding}${content}\n${closeBrace}`;
            });

            const lines = text.split('\n');
            const newLines = [];
            const indentUnit = '    ';
            let indentLevel = 0;

            for (const line of lines) {
                if (!line.trim()) {
                    newLines.push('');
                    continue;
                }
                let trimmedLine = line.trim();
                const startsWithClosing = trimmedLine.startsWith('}') || trimmedLine.startsWith(')');
                if (startsWithClosing) indentLevel = Math.max(0, indentLevel - 1);

                let indentedLine = indentUnit.repeat(indentLevel) + trimmedLine;

                // Espaces opérateurs
                indentedLine = indentedLine.replace(/\s+/g, ' ');
                indentedLine = indentedLine.replace(/^(if|while|for)\s*\(\s*/i, '$1 (');
                const binaryOps = ['\\?\\?=', '\\?=', '\\+=', '-=', '\\*=', '/=', '%=', '==', '!=', '>=', '<=', '><', '(?<!<)<(?!<)', '(?<!>)>(?!>)', '=', '&&', '\\|\\|', ':[-+\\*\\/%]?='];
                const binaryRegex = new RegExp(`\\s*(${binaryOps.join('|')})\\s*`, 'g');
                indentedLine = indentedLine.replace(binaryRegex, ' $1 ');

                // Nettoyage divers
                indentedLine = indentedLine.replace(/=\s*>/g, '=>');
                indentedLine = indentedLine.replace(/\)\s*\{/g, ') {');
                indentedLine = indentedLine.replace(/;\s*/g, '; ');
                indentedLine = indentedLine.replace(/\s*,\s*/g, ', ');
                indentedLine = indentedLine.replace(/\{\s*(\S)/g, '{ $1');
                indentedLine = indentedLine.replace(/(\S)\s*\}/g, '$1 }');
                indentedLine = indentedLine.replace(/\}\s*(?![,;\)])/g, '} ');
                indentedLine = indentedLine.replace(/\s+\)/g, ')');
                indentedLine = indentedLine.replace(/\(\s+/g, '(');

                indentedLine = (indentUnit.repeat(indentLevel) + indentedLine.trim()).trimEnd();
                newLines.push(indentedLine);

                const endsWithOpening = trimmedLine.endsWith('{') || trimmedLine.endsWith('(');
                if (endsWithOpening) indentLevel++;
            }

            let finalResult = newLines.join('\n');

            // --- CORRECTION : Appliquer la fusion des accolades vides ICI, à la toute fin ---
            // Cela gère le cas : 
            // execute run {
            // }
            // Qui a été transformé par la boucle en :
            // execute run {
            // } (avec indentation)
            // On veut le ramener à : execute run { }
            // On utilise \s+ pour capturer les sauts de ligne potentiels restants
            finalResult = finalResult.replace(/\{\s+\}/g, '{ }');
            // -------------------------------------------------------------------------------

            strings.forEach((str, idx) => {
                const tokenRegex = new RegExp(`__STR_${idx}__`, "g");
                finalResult = finalResult.replace(tokenRegex, str);
            });

            if (finalResult === originalText) return [];
            const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(originalText.length));
            return [vscode.TextEdit.replace(fullRange, finalResult)];
        }
    });
}
module.exports = { registerFormatter };
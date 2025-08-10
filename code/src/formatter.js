// src/formatter.js
const vscode = require('vscode');

function registerFormatter() {
    return vscode.languages.registerDocumentFormattingEditProvider('jmc', {
        provideDocumentFormattingEdits(document) {
            let originalText = document.getText();

            // 1. Protéger les chaînes de caractères (simples, doubles et littérales/backticks)
            const strings = [];
            // L'expression régulière est étendue pour inclure les template literals (`...`)
            // `([\s\S]*?)` capture tout le contenu, y compris les sauts de ligne, de manière non-gourmande.
            const stringRegex = /"([^"\\]*(\\.[^"\\]*)*)"|'([^'\\]*(\\.[^'\\]*)*)'|`([\s\S]*?)`/g;
            let text = originalText.replace(stringRegex, (match) => {
                const token = `__STR_${strings.length}__`;
                strings.push(match);
                return token;
            });

            // 2. Gérer les sauts de ligne autour des accolades
            // Règle A : { suivi par du code sur la même ligne -> ajouter \n
            // Ex: "function() {\n    say();" est OK. "function() {say();" devient "function() {\nsay();"
            text = text.replace(/(\{)(\s*)(\S)(.*?)(\r?\n|$)/g, (match, openBrace, whitespace, content, rest, eol) => {
                // Si le reste de la ligne contient l'accolade fermante, on ne touche à rien (cas { say(); })
                if (rest.includes('}')) {
                    return match;
                }
                return `${openBrace}\n${content}${rest}${eol}`;
            });

            // Règle B : } précédé par du code sur la même ligne -> ajouter \n
            // Ex: "    say();\n}" est OK. "    say();}" devient "    say();\n}"
            text = text.replace(/(\r?\n|^)(.*?)(\S)(\s*)(\})/g, (match, eol, preceding, content, whitespace, closeBrace) => {
                // Si le début de la ligne contient l'accolade ouvrante, on ne touche à rien (cas { say(); })
                if (preceding.includes('{')) {
                    return match;
                }
                return `${eol}${preceding}${content}\n${closeBrace}`;
            });

            // 3. Traiter chaque ligne pour l'indentation et l'espacement
            const lines = text.split('\n');
            const newLines = [];
            const indentUnit = '    ';
            let indentLevel = 0;

            for (const line of lines) {
                // Conserver les lignes vides intentionnelles
                if (!line.trim()) {
                    newLines.push('');
                    continue;
                }

                let trimmedLine = line.trim();

                // Gérer l'indentation pour les blocs qui se terminent
                const startsWithClosing = trimmedLine.startsWith('}') || trimmedLine.startsWith(')');
                if (startsWithClosing) {
                    indentLevel = Math.max(0, indentLevel - 1);
                }

                // Appliquer l'indentation actuelle
                let indentedLine = indentUnit.repeat(indentLevel) + trimmedLine;

                // Appliquer les règles d'espacement
                indentedLine = indentedLine.replace(/\s+/g, ' '); // Remplacer les espaces multiples par un seul
                indentedLine = indentedLine.replace(/^(if|while|for)\s*\(\s*/i, '$1 (');

                const binaryOps = [
                    '\\?\\?=', '\\?=', '\\+=', '-=', '\\*=', '/=', '%=',
                    '==', '!=', '>=', '<=', '><', '(?<!<)<(?!<)', '(?<!>)>(?!>)', '=',
                    '&&', '\\|\\|'
                ];

                const binaryRegex = new RegExp(`\\s*(${binaryOps.join('|')})\\s*`, 'g');
                indentedLine = indentedLine.replace(binaryRegex, ' $1 ');

                // Exceptions et nettoyage des espaces
                indentedLine = indentedLine.replace(/=\s*>/g, '=>'); // Pour les fonctions fléchées
                indentedLine = indentedLine.replace(/\)\s*\{/g, ') {');
                indentedLine = indentedLine.replace(/;\s*/g, '; ');
                indentedLine = indentedLine.replace(/\s*,\s*/g, ', ');
                indentedLine = indentedLine.replace(/\{\s*(\S)/g, '{ $1');
                indentedLine = indentedLine.replace(/(\S)\s*\}/g, '$1 }');
                indentedLine = indentedLine.replace(/\}\s*(?![,;\)])/g, '} ');
                indentedLine = indentedLine.replace(/\s+\)/g, ')'); // ex: ( a, b ) -> (a, b)
                indentedLine = indentedLine.replace(/\(\s+/g, '(');

                // Re-trim après l'ajout d'espaces pour garder une ligne propre
                indentedLine = (indentUnit.repeat(indentLevel) + indentedLine.trim()).trimEnd();


                newLines.push(indentedLine);

                // Gérer l'indentation pour les blocs qui commencent
                const endsWithOpening = trimmedLine.endsWith('{') || trimmedLine.endsWith('(');
                if (endsWithOpening) {
                    indentLevel++;
                }
            }

            // 4. Reconstituer le texte et restaurer les chaînes
            let finalResult = newLines.join('\n');
            strings.forEach((str, idx) => {
                const tokenRegex = new RegExp(`__STR_${idx}__`, "g");
                finalResult = finalResult.replace(tokenRegex, str);
            });


            // 5. Appliquer la modification si nécessaire
            if (finalResult === originalText) {
                return [];
            }

            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(originalText.length)
            );

            return [vscode.TextEdit.replace(fullRange, finalResult)];
        }
    });
}
module.exports = { registerFormatter };
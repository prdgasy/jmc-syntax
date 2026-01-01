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

            // 1. Accolades { }
            text = text.replace(/(\{)(\s*)(\S)(.*?)(\r?\n|$)/g, (match, openBrace, whitespace, content, rest, eol) => {
                if (rest.includes('}')) return match;
                // Si c'est {} vide, on ne touche pas ici, ce sera géré à la fin
                if (content === '}') return match;
                return `${openBrace}\n${content}${rest}${eol}`;
            });
            text = text.replace(/(\r?\n|^)(.*?)(\S)(\s*)(\})/g, (match, eol, preceding, content, whitespace, closeBrace) => {
                if (preceding.includes('{')) return match;
                return `${eol}${preceding}${content}\n${closeBrace}`;
            });

            // 2. Crochets [ ] (Listes)
            // MODIFICATION : Regex plus stricte pour ne pas casser [] ou [ ]
            // On cherche [ suivi de quelque chose qui N'EST PAS ] (ni juste des espaces puis ])
            text = text.replace(/(\[)(?!\s*\])(\s*)(\S)(.*?)(\r?\n|$)/g, (match, openBracket, whitespace, content, rest, eol) => {
                // Si la ligne contient aussi la fermeture, on ne coupe pas (ex: [1, 2])
                if ((content + rest).includes(']')) return match;
                return `${openBracket}\n${content}${rest}${eol}`;
            });

            text = text.replace(/(\r?\n|^)(.*?)(\S)(\s*)(\])/g, (match, eol, preceding, content, whitespace, closeBracket) => {
                if (preceding.includes('[')) return match;
                return `${eol}${preceding}${content}\n${closeBracket}`;
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

                const startsWithClosing = trimmedLine.startsWith('}') || trimmedLine.startsWith(')') || trimmedLine.startsWith(']');
                if (startsWithClosing) indentLevel = Math.max(0, indentLevel - 1);

                let indentedLine = indentUnit.repeat(indentLevel) + trimmedLine;

                indentedLine = indentedLine.replace(/\s+/g, ' ');
                indentedLine = indentedLine.replace(/^(if|while|for)\s*\(\s*/i, '$1 (');
                const binaryOps = ['\\?\\?=', '\\?=', '\\+=', '-=', '\\*=', '/=', '%=', '==', '!=', '>=', '<=', '><', '(?<!<)<(?!<)', '(?<!>)>(?!>)', '=', '&&', '\\|\\|', ':[-+\\*\\/%]?='];
                const binaryRegex = new RegExp(`\\s*(${binaryOps.join('|')})\\s*`, 'g');
                indentedLine = indentedLine.replace(binaryRegex, ' $1 ');

                indentedLine = indentedLine.replace(/=\s*>/g, '=>');
                indentedLine = indentedLine.replace(/\)\s*\{/g, ') {');
                indentedLine = indentedLine.replace(/;\s*/g, '; ');
                indentedLine = indentedLine.replace(/\s*,\s*/g, ', ');
                indentedLine = indentedLine.replace(/\{\s*(\S)/g, '{ $1');
                indentedLine = indentedLine.replace(/(\S)\s*\}/g, '$1 }');
                indentedLine = indentedLine.replace(/\}\s*(?![,;\)])/g, '} ');
                indentedLine = indentedLine.replace(/\s+\)/g, ')');
                indentedLine = indentedLine.replace(/\(\s+/g, '(');

                // Correction pour ne pas casser les crochets vides []
                indentedLine = indentedLine.replace(/\[\s+\]/g, '[]');

                indentedLine = (indentUnit.repeat(indentLevel) + indentedLine.trim()).trimEnd();
                newLines.push(indentedLine);

                // On n'augmente l'indentation que si la ligne ne finit PAS par ] ou ) ou }
                // ET qu'elle finit par une ouverture.
                // Cas spécifique : [] ne doit pas augmenter l'indentation
                const endsWithOpening =
                    (trimmedLine.endsWith('{') && !trimmedLine.endsWith('{}')) ||
                    (trimmedLine.endsWith('(') && !trimmedLine.endsWith('()')) ||
                    (trimmedLine.endsWith('[') && !trimmedLine.endsWith('[]'));

                if (endsWithOpening) indentLevel++;
            }

            let finalResult = newLines.join('\n');

            finalResult = finalResult.replace(/\{\s+\}/g, '{ }');
            finalResult = finalResult.replace(/\[\s+\]/g, '[]'); // Force [] collé pour vide

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
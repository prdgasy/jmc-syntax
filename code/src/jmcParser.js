function parseFunctionsAndClasses(text) {
    const lines = text.split('\n');
    const classMap = new Map();
    const functionMap = new Map();

    const classRegex = /^\s*(?:@(\w+)\s+)?class\s+([a-zA-Z_]\w*)/;
    const functionRegex = /^\s*(?:@([a-zA-Z_-]+(?:\([^)]*\))?)\s+)?function\s+([\w.]+)\s*\(/;


    let currentClass = null;
    let commentBlock = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//')) {
            commentBlock.push(trimmed.slice(2).trim());
            continue;
        }

        const classMatch = line.match(classRegex);
        if (classMatch) {
            currentClass = classMatch[2];
            classMap.set(currentClass, { functions: [] });
            commentBlock = [];
            continue;
        }

        const functionMatch = line.match(functionRegex);
        if (functionMatch) {
            const functionName = functionMatch[2];
            const descriptionLines = [];
            let inDesc = false;

            for (const line of commentBlock) {
                if (line.startsWith('@description')) {
                    descriptionLines.push(line.replace('@description', '').trim());
                    inDesc = true;
                } else if (inDesc) {
                    descriptionLines.push(line);
                }
            }

            const description = descriptionLines.join('\n').trim();
            functionMap.set(functionName, {
                inClass: currentClass,
                description
            });
        }

        if (trimmed !== '') {
            commentBlock = [];
        }
    }

    return { classMap, functionMap };
}

function parseParams(body) {
    const signatureLine = body.find(l => l.includes('('));
    const paramsString = signatureLine?.match(/\(([^)]*)\)/)?.[1];
    if (!paramsString?.trim()) return [];
    return paramsString.split(',')
        .map(p => p.trim().replace(/\$\{\d+:?([^}]*)\}/, '$1').split(':')[0].trim())
        .filter(Boolean);
}

// src/jmcParser.js

function paramType(name) {
    const types = {
        value: 'Scoreboard | FormattedString', function: 'Function', selector: 'TargetSelector',
        message: 'FormattedString', objective: 'Keyword', criteria: 'Criteria',
        score: 'Scoreboard', variable: 'Scoreboard', n: 'Number', min: 'ScoreboardInteger',
        max: 'ScoreboardInteger', text: 'FormattedString', ondeath: 'Function',
        onrespawn: 'Function', baseitem: 'Item', oncraft: 'Function', mode: 'Keyword',
        tick: 'ScoreboardInteger', recipe: 'JSON', indexstring: 'string',
        indexstrings: 'List<string>', strings: 'List<string>', stringlists: 'List<List<string>>',
        arrowfunction: 'ArrowFunction', start: 'integer', stop: 'integer', step: 'integer',
        switch: 'Scoreboard', count: 'integer', begin_at: 'integer',
        triggers: 'JSObject<integer, Function>', predicate: 'JSON', xmin: 'integer',
        xmax: 'integer', ymin: 'integer', ymax: 'integer', zmin: 'integer', zmax: 'integer',
        particle: 'string', radius: 'float', spread: 'integer', speed: 'integer',
        height: 'float', spreadxz: 'integer', spready: 'integer', distance: 'float',
        length: 'float', align: 'Keyword', onhit: 'Function', onstep: 'Function',
        onbeforestep: 'Function', interval: 'float', maxiter: 'integer', boxsize: 'float',
        target: 'TargetSelector', startateye: 'boolean', stopatentity: 'boolean',
        stopatblock: 'boolean', runatend: 'boolean', castertag: 'Keyword',
        removecastertag: 'boolean', modifyexecutebeforestep: 'string',
        modifyexecuteafterstep: 'string', overidestring: 'string',
        overiderecursion: 'ArrowFunction', command: 'string', pythoncode: 'string',
        pythonfile: 'string', env: 'string', jmc: 'boolean', source: 'string',
        path: 'Keyword', string: 'string', source1: 'string', path1: 'Keyword',
        source2: 'string', path2: 'Keyword', displayname: 'FormattedString',
        team: 'Keyword', members: 'TargetSelector', id: 'Keyword', property: 'Keyword',

        // --- AJOUTS ---
        tag: 'Keyword',
        removefrom: 'TargetSelector'
        // ----------------
    };
    return types[name.toLowerCase()] || 'any';
}

function getDefinedFunctionsFromText(text) {
    return [...text.matchAll(/function\s+([a-zA-Z_][\w.]*)\s*\(/g)].map(m => m[1]);
}

function getAllCallIdentifiers(text) {
    return [...text.matchAll(/\b(?:[a-zA-Z_][\w.]*\.)*[a-zA-Z_][\w.]*\s*\(/g)]
        .filter(m => !/function\s*$/.test(text.slice(0, m.index)))
        .map(m => m[0].replace(/\s*\($/, ''));
}

function extractVariables(text) {
    const normal = [...new Set([...text.matchAll(/\$([a-zA-Z_][\w.]*)/g)].map(m => m[1]))];
    const storage = [...new Set([...text.matchAll(/::([a-zA-Z_][\w.]*)/g)].map(m => m[1]))];
    return { normal, storage };
}



module.exports = {
    parseParams,
    paramType,
    getDefinedFunctionsFromText,
    getAllCallIdentifiers,
    extractVariables,
    parseFunctionsAndClasses
};

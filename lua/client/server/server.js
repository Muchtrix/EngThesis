/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const vscode_languageserver_1 = require("vscode-languageserver");
const util_1 = require("util");
const stdLib = require("./stdLib.json");
// Create a connection for the server. The connection uses Node's IPC as a transport
let connection = vscode_languageserver_1.createConnection(new vscode_languageserver_1.IPCMessageReader(process), new vscode_languageserver_1.IPCMessageWriter(process));
// Create a simple text document manager. The text document manager
// supports full document sync only
let documents = new vscode_languageserver_1.TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);
function ToAstPosition(pos) {
    return { line: pos.line + 1, column: pos.character };
}
function ToFileRange(node) {
    return {
        start: {
            line: node.loc.start.line - 1,
            character: node.loc.start.column
        },
        end: {
            line: node.loc.end.line - 1,
            character: node.loc.end.column
        }
    };
}
function ToFileLocation(node, fileUri) {
    return {
        uri: fileUri,
        range: ToFileRange(node)
    };
}
function positionLeq(left, right) {
    return (left.line < right.line) || ((left.line === right.line) && (left.column <= right.column));
}
function inRange(elem, range) {
    return positionLeq(range.start, elem) && positionLeq(elem, range.end);
}
function TraverseTreeDown(p, node) {
    if (!inRange(p, node.loc))
        return undefined;
    if (node.body !== undefined) {
        for (let son of node.body) {
            let r = TraverseTreeDown(p, son);
            if (r !== undefined)
                return r;
        }
    }
    switch (node.type) {
        case 'CallStatement':
            let r = TraverseTreeDown(p, node.expression);
            if (r != undefined)
                return r;
            break;
        case 'CallExpression':
        case 'ReturnStatement':
            for (let arg of node.arguments) {
                let r = TraverseTreeDown(p, arg);
                if (r != undefined)
                    return r;
            }
            break;
        case 'FunctionDeclaration':
            for (let arg of node.parameters) {
                let r = TraverseTreeDown(p, arg);
                if (r != undefined)
                    return r;
            }
            break;
        case 'LocalStatement':
        case 'AssignmentStatement':
            for (let v of node.variables) {
                let r = TraverseTreeDown(p, v);
                if (r != undefined)
                    return r;
            }
            for (let v of node.init) {
                let r = TraverseTreeDown(p, v);
                if (r != undefined)
                    return r;
            }
    }
    return node;
}
function ParseVarName(node) {
    switch (node.type) {
        case 'Identifier':
            return node.name;
        case 'IndexExpression':
            return ParseVarName(node.base) + '.' + ParseVarName(node.index);
        case 'MemberExpression':
            return ParseVarName(node.identifier) + '.' + ParseVarName(node.base);
        case 'NumericLiteral':
        case 'StringLiteral':
            return node.value.toString();
    }
    return null;
}
function FindIdentifiers(p, node) {
    function FindIdentifiers(p, node, res) {
        if (node.type == 'Chunk' && node.globals !== undefined) {
            for (let g of node.globals) {
                res[g.name] = g;
            }
        }
        switch (node.type) {
            case 'AssignmentStatement':
            case 'LocalStatement':
            case 'ForGenericStatement':
                for (let i of node.variables) {
                    res[i.name] = i;
                }
                break;
            case 'FunctionDeclaration':
                res[node.identifier.name] = node.identifier;
                break;
            case 'ForNumericStatement':
                res[node.variable.name] = node.variable;
                break;
        }
        if (inRange(p, node.loc) && node.body !== undefined) {
            for (let g of node.body) {
                if (positionLeq(g.loc.start, p))
                    res = FindIdentifiers(p, g, res);
            }
        }
        return res;
    }
    return FindIdentifiers(p, node, {});
}
let printableType = {
    'LabelStatement': 'label',
    'BreakStatement': 'break',
    'GotoStatement': 'goto',
    'ReturnStatement': 'return',
    'IfStatement': 'if',
    'IfClause': 'if clause',
    'ElseifClause': 'elseif clause',
    'ElseClause': 'else clause',
    'WhileStatement': 'while loop',
    'DoStatement': 'do',
    'RepeatStatement': 'repeat',
    'AssignmentStatement': 'assignment',
    'FunctionDeclaration': 'function'
};
function AstNodeToMarkedString(node) {
    if (node.type === 'chunk')
        return undefined;
    let type = printableType[node.type] || node.type;
    return ['### ' + type, '', '---'].join('\n');
}
let luaparser = require('luaparse');
let fileASTs = {};
// After the server has started the client sends an initilize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilites. 
let workspaceRoot;
connection.onInitialize((params) => {
    workspaceRoot = params.rootPath;
    util_1.debug(workspaceRoot);
    return {
        capabilities: {
            // Tell the client that the server works in FULL text document sync mode
            textDocumentSync: documents.syncKind,
            // Tell the client that the server support code complete
            completionProvider: {
                resolveProvider: true
            },
            hoverProvider: true,
            definitionProvider: true
        }
    };
});
// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
    validateTextDocument(change.document);
});
// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration((_) => {
    // Revalidate any open text documents
    documents.all().forEach(validateTextDocument);
});
function validateTextDocument(textDocument) {
    let diagnostics = [];
    try {
        let ast = luaparser.parse(textDocument.getText(), { scope: true, locations: true });
        fileASTs[textDocument.uri] = ast;
    }
    catch (e) {
        if (e instanceof SyntaxError) {
            let posInfo = e.message.substring(e.message.indexOf('['), e.message.indexOf(']'));
            let regex = /[0-9]+/g;
            let coords = posInfo.match(regex).map((x, _) => +x);
            let pos = { line: coords[0] - 1, character: coords[1] };
            let p = textDocument.positionAt(textDocument.offsetAt(pos) - 1);
            diagnostics.push({
                severity: vscode_languageserver_1.DiagnosticSeverity.Error,
                range: {
                    start: p,
                    end: p
                },
                message: e.message
            });
        }
    }
    finally {
        connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
    }
}
connection.onHover((params) => {
    let tree = fileASTs[params.textDocument.uri];
    if (tree === undefined)
        return undefined;
    let resNode = TraverseTreeDown(ToAstPosition(params.position), tree);
    if (resNode !== undefined) {
        let markedString = AstNodeToMarkedString(resNode);
        if (markedString !== undefined)
            return { contents: markedString };
    }
    return null;
});
connection.onDefinition((_params) => {
    let symbol = TraverseTreeDown(ToAstPosition(_params.position), fileASTs[_params.textDocument.uri]);
    if (symbol.type == 'CallExpression')
        symbol = symbol.base;
    else if (symbol.type == 'FunctionDeclaration')
        symbol = symbol.identifier;
    if (symbol.type == 'Identifier') {
        let def = FindIdentifiers(ToAstPosition(_params.position), fileASTs[_params.textDocument.uri])[symbol.name];
        if (def === undefined)
            return null;
        return ToFileLocation(def, _params.textDocument.uri);
    }
    return null;
});
connection.onDidChangeWatchedFiles((_change) => {
    // Monitored files have change in VSCode
    connection.console.log('We recevied an file change event');
});
// This handler provides the initial list of the completion items.
connection.onCompletion((textDocumentPosition) => {
    // The pass parameter contains the position of the text document in 
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.
    let declarations = FindIdentifiers(ToAstPosition(textDocumentPosition.position), fileASTs[textDocumentPosition.textDocument.uri]);
    let res = [];
    for (let ident in declarations) {
        let kind;
        if (declarations[ident].type === 'FunctionDeclaration') {
            kind = vscode_languageserver_1.CompletionItemKind.Function;
        }
        else {
            kind = vscode_languageserver_1.CompletionItemKind.Variable;
        }
        res.push({
            label: ident,
            kind: kind,
            data: declarations[ident]
        });
    }
    stdLib.Variables.forEach((v) => {
        res.push({ label: v, kind: vscode_languageserver_1.CompletionItemKind.Variable });
    });
    stdLib.Functions.forEach((f) => {
        res.push({ label: f, kind: vscode_languageserver_1.CompletionItemKind.Function });
    });
    return res;
});
// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item) => {
    return item;
});
/*
connection.onDidOpenTextDocument((params) => {
    // A text document got opened in VSCode.
    // params.uri uniquely identifies the document. For documents store on disk this is a file URI.
    // params.text the initial full content of the document.
    connection.console.log(`${params.textDocument.uri} opened.`);
});
connection.onDidChangeTextDocument((params) => {
    // The content of a text document did change in VSCode.
    // params.uri uniquely identifies the document.
    // params.contentChanges describe the content changes to the document.
    connection.console.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
});
connection.onDidCloseTextDocument((params) => {
    // A text document got closed in VSCode.
    // params.uri uniquely identifies the document.
    connection.console.log(`${params.textDocument.uri} closed.`);
});
*/
// Listen on the connection
connection.listen();
//# sourceMappingURL=server.js.map
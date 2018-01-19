'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const vscode_languageserver_1 = require("vscode-languageserver");
const stdLib = require("./stdLib.json");
const astUtils = require("./ast-utilities");
let connection = vscode_languageserver_1.createConnection(new vscode_languageserver_1.IPCMessageReader(process), new vscode_languageserver_1.IPCMessageWriter(process));
let documents = new vscode_languageserver_1.TextDocuments();
documents.listen(connection);
let luaparser = require('luaparse');
let fileASTs = {};
// Handler komunikatu Initialize
connection.onInitialize((_params) => {
    return {
        capabilities: {
            textDocumentSync: documents.syncKind,
            completionProvider: {
                resolveProvider: false
            },
            hoverProvider: true,
            definitionProvider: true
        }
    };
});
// Handler komunikatu DidChangeDocument
documents.onDidChangeContent((change) => {
    validateTextDocument(change.document);
});
// Handler komunikatu DidChangeConfiguration
connection.onDidChangeConfiguration((_params) => {
    documents.all().forEach(validateTextDocument);
});
// Funkcja pomocnicza tworząca drzewa rozbioru programu
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
// Handler zapytania Hover
connection.onHover((params) => {
    let tree = fileASTs[params.textDocument.uri];
    if (tree === undefined)
        return undefined;
    let resNode = astUtils.TraverseTreeDown(astUtils.ToAstPosition(params.position), tree);
    if (resNode !== undefined) {
        let markedString = astUtils.AstNodeToMarkedString(resNode);
        if (markedString !== undefined)
            return { contents: markedString, range: astUtils.ToFileRange(resNode) };
    }
    return null;
});
// Handler zapytania Definition
connection.onDefinition((_params) => {
    let symbol = astUtils.TraverseTreeDown(astUtils.ToAstPosition(_params.position), fileASTs[_params.textDocument.uri]);
    if (symbol.type == 'CallExpression')
        symbol = symbol.base;
    else if (symbol.type == 'FunctionDeclaration')
        symbol = symbol.identifier;
    if (symbol.type == 'Identifier') {
        let def = astUtils.FindIdentifiers(astUtils.ToAstPosition(_params.position), fileASTs[_params.textDocument.uri])[symbol.name];
        if (def === undefined)
            return null;
        return astUtils.ToFileLocation(def.node, _params.textDocument.uri);
    }
    return null;
});
// Handler zapytania Completion
connection.onCompletion((textDocumentPosition) => {
    let declarations = astUtils.FindIdentifiers(astUtils.ToAstPosition(textDocumentPosition.position), fileASTs[textDocumentPosition.textDocument.uri]);
    let res = [];
    for (let ident in declarations) {
        if (declarations[ident].type === astUtils.identifierType.Function) {
            res.push({
                label: astUtils.LabelifyFunctionNode(declarations[ident].node, false),
                insertText: astUtils.LabelifyFunctionNode(declarations[ident].node, true),
                insertTextFormat: vscode_languageserver_1.InsertTextFormat.Snippet,
                kind: vscode_languageserver_1.CompletionItemKind.Function
            });
        }
        else {
            res.push({
                kind: vscode_languageserver_1.CompletionItemKind.Variable,
                label: ident
            });
        }
    }
    stdLib.Variables.forEach((v) => {
        res.push({ label: v, kind: vscode_languageserver_1.CompletionItemKind.Variable });
    });
    stdLib.Functions.forEach((f) => {
        res.push({ label: f.label, insertText: f.snippet, kind: vscode_languageserver_1.CompletionItemKind.Function, insertTextFormat: vscode_languageserver_1.InsertTextFormat.Snippet });
    });
    return res;
});
// Uruchomienie serwera
connection.listen();
//# sourceMappingURL=server.js.map
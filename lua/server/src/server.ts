/// <reference path="./ast-utilities.ts"/>
'use strict';

import {
	IPCMessageReader, IPCMessageWriter, createConnection, IConnection, TextDocuments, TextDocument, 
	Diagnostic, DiagnosticSeverity, InitializeResult, TextDocumentPositionParams, CompletionItem, 
	CompletionItemKind,
	InsertTextFormat,
} from 'vscode-languageserver';
import * as stdLib from './stdLib.json';
import * as astUtils from './ast-utilities';

let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
let documents: TextDocuments = new TextDocuments();
documents.listen(connection);

let luaparser = require('luaparse');
let fileASTs: {[id: string]: astUtils.astNode} = {};

// Handler komunikatu Initialize
connection.onInitialize((_params): InitializeResult => {
	return {
		capabilities: {
			textDocumentSync: documents.syncKind,
			completionProvider: {
				resolveProvider: true
			},
			hoverProvider: true,
			definitionProvider: true
		}
	}
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
function validateTextDocument(textDocument: TextDocument): void {
	let diagnostics: Diagnostic[] = [];
	try {
		let ast:astUtils.astNode = luaparser.parse(textDocument.getText(), {scope: true, locations: true});
		fileASTs[textDocument.uri] = ast;
	} catch (e) {
		if (e instanceof SyntaxError){
			let posInfo = e.message.substring(e.message.indexOf('['), e.message.indexOf(']'));
			let regex = /[0-9]+/g;
			let coords = posInfo.match(regex).map((x, _) => +x);
			let pos = {line: coords[0] - 1, character: coords[1]};
			let p = textDocument.positionAt(textDocument.offsetAt(pos) - 1);
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
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
connection.onHover((params: TextDocumentPositionParams) => {
	let tree : astUtils.astNode = fileASTs[params.textDocument.uri];
	if (tree === undefined) return undefined;
	let resNode = astUtils.TraverseTreeDown(astUtils.ToAstPosition(params.position), tree);
	if (resNode !== undefined) {
		let markedString = astUtils.AstNodeToMarkedString(resNode);
		if (markedString !== undefined) return {contents: markedString};
	}
	return null;
});

// Handler zapytania Definition
connection.onDefinition((_params: TextDocumentPositionParams) => {
	let symbol = astUtils.TraverseTreeDown(astUtils.ToAstPosition(_params.position), fileASTs[_params.textDocument.uri]);
	if (symbol.type == 'CallExpression') symbol = symbol.base;
	else if (symbol.type == 'FunctionDeclaration') symbol = symbol.identifier;
	if (symbol.type == 'Identifier'){
		let def =  astUtils.FindIdentifiers(astUtils.ToAstPosition(_params.position), fileASTs[_params.textDocument.uri])[symbol.name];
		if (def === undefined) return null;
		return astUtils.ToFileLocation(def.node, _params.textDocument.uri);
	}
	return null;
});

// Handler zapytania Completion
connection.onCompletion((textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
	let declarations = astUtils.FindIdentifiers(astUtils.ToAstPosition(textDocumentPosition.position), fileASTs[textDocumentPosition.textDocument.uri]);
	let res : any[] = [];
	for(let ident in declarations){
		if (declarations[ident].type === astUtils.identifierType.Function){
			res.push({
				label: astUtils.LabelifyFunctionNode(declarations[ident].node, false),
				insertText: astUtils.LabelifyFunctionNode(declarations[ident].node, true),
				insertTextFormat: InsertTextFormat.Snippet,
				kind: CompletionItemKind.Function
			});
		} else {
			res.push({
				kind: CompletionItemKind.Variable,
				label: ident
			});
		}
	}
	(<any>stdLib).Variables.forEach((v : string) => {
		res.push({label: v, kind: CompletionItemKind.Variable});
	});
	(<any>stdLib).Functions.forEach((f : string) => {
		res.push({label: f, insertText: f, kind: CompletionItemKind.Function, insertTextFormat: InsertTextFormat.Snippet});
	});
	return res;
});

// Uruchomienie serwera
connection.listen();

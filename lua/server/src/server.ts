/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	IPCMessageReader, IPCMessageWriter, createConnection, IConnection, TextDocuments, TextDocument, 
	Diagnostic, DiagnosticSeverity, InitializeResult, TextDocumentPositionParams, CompletionItem, 
	CompletionItemKind,
	Position,
	Range,
//	DocumentLink,
	Location,
	//MarkedString, MarkupContent
	//Position
} from 'vscode-languageserver';
import { debug } from 'util';

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

interface astPosition {
	line: number,
	column: number
}

interface astRange {
	start: astPosition
	end: astPosition
}

interface astNode {
	type: string
	loc: astRange
	body?: astNode[]
	name?: string
	expression?: astNode
	base?: astNode
	arguments?: astNode[]
	isLocal?: boolean
	globals?: astNode[]
	variables?: astNode[]
	init?: astNode[]
	values?: astNode[]
	parameters?: astNode[]
	identifier?: astNode
	variable?: astNode
	index?: astNode
	value?: number | string
}

function ToAstPosition(pos: Position) {
	return {line : pos.line + 1, column : pos.character}
}

function ToFileRange(node: astNode): Range {
	return {
		start:{
			line: node.loc.start.line - 1,
			character: node.loc.start.column
		},
		end:{
			line: node.loc.end.line - 1,
			character: node.loc.end.column
		}
	}
}

function ToFileLocation(node: astNode, fileUri: string): Location{
	return {
		uri: fileUri,
		range: ToFileRange(node)
	}
}

function positionLeq (left: astPosition, right: astPosition): boolean {
	return (left.line < right.line) || ((left.line === right.line) && (left.column <= right.column));
}

function inRange (elem: astPosition, range: astRange): boolean {
	return positionLeq(range.start, elem) && positionLeq(elem, range.end);
}

function TraverseTreeDown(p: astPosition, node: astNode): astNode {
	if (!inRange(p, node.loc)) return undefined;
	if (node.body !== undefined) {
		for (let son of node.body) {
			let r = TraverseTreeDown(p, son);
			if (r !== undefined) return r;
		}
	}
	switch(node.type){
		case 'CallStatement':
			let r = TraverseTreeDown(p, node.expression);
			if (r != undefined) return r;
			break;
		case 'CallExpression':
		case 'ReturnStatement':
			for (let arg of node.arguments) {
				let r = TraverseTreeDown(p, arg);
				if (r != undefined) return r;
			}
			break;
		case 'FunctionDeclaration':
			for (let arg of node.parameters) {
				let r = TraverseTreeDown(p, arg);
				if (r != undefined) return r;
			}
			break;
		case 'LocalStatement':
		case 'AssignmentStatement':
			for (let v of node.variables) {
				let r = TraverseTreeDown(p, v);
				if (r != undefined) return r;
			}
			for (let v of node.init) {
				let r = TraverseTreeDown(p, v);
				if(r != undefined) return r;
			}
	}
	return node;
}

function ParseVarName(node:astNode): string{
	switch (node.type){
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

function FindIdentifiers(p: astPosition, node: astNode): {[id: string]: astNode}{
	function FindIdentifiers(p: astPosition, node: astNode, res: {[id: string]: astNode}): {[id: string]: astNode} {
		if (node.type == 'Chunk' && node.globals !== undefined) {
			for (let g of node.globals){
				res[g.name] = g;
			}
		}
		switch(node.type){
			case 'AssignmentStatement':
			case 'LocalStatement':
			case 'ForGenericStatement':
				for(let i of node.variables){
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

		if (inRange(p, node.loc) && node.body !== undefined){
			for(let g of node.body){
				if (positionLeq(g.loc.start, p))
					res = FindIdentifiers(p, g, res);
			}
		}
	
		return res;
	}
	return FindIdentifiers(p, node, {});
}



let printableType: {[type: string]: string} = {
	'LabelStatement' : 'label',
	'BreakStatement' : 'break',
	'GotoStatement' : 'goto',
	'ReturnStatement' : 'return',
	'IfStatement' : 'if',
	'IfClause' : 'if clause',
	'ElseifClause' : 'elseif clause',
	'ElseClause' : 'else clause',
	'WhileStatement' : 'while loop',
	'DoStatement' : 'do',
	'RepeatStatement' : 'repeat',
	'AssignmentStatement' : 'assignment',
	'FunctionDeclaration' : 'function'
}

function AstNodeToMarkedString(node: astNode) {
	if (node.type === 'chunk') return undefined;
	let type:string = printableType[node.type] || node.type;
	return ['### '+type, '', '---'].join('\n');
}

let luaparser = require('luaparse');
let fileASTs: {[id: string]: astNode} = {};

// After the server has started the client sends an initilize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilites. 
let workspaceRoot: string;
connection.onInitialize((params): InitializeResult => {
	workspaceRoot = params.rootPath;
	debug(workspaceRoot)
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
	}
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

function validateTextDocument(textDocument: TextDocument): void {
	let diagnostics: Diagnostic[] = [];
	try {
		let ast:astNode = luaparser.parse(textDocument.getText(), {scope: true, locations: true});
		fileASTs[textDocument.uri] = ast;
	} catch (e) {
		if (e instanceof SyntaxError){
			let posInfo = e.message.substring(e.message.indexOf('['), e.message.indexOf(']'));
			let message = e.message.substring(posInfo.length + 2, e.message.lastIndexOf(" near"));
			let coords = posInfo.match('[0-9]+').map((x, _) => +x);
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: {
					start: {line: coords[0], character: coords[1]},
					end: {line: coords[0], character: coords[1]}
				},
				message: message
			});
		}
	}
	finally {
		connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
	}
}

connection.onHover((params: TextDocumentPositionParams) => {
	let tree : astNode = fileASTs[params.textDocument.uri];
	if (tree === undefined) return undefined;
	let resNode = TraverseTreeDown(ToAstPosition(params.position), tree);
	if (resNode !== undefined) {
		let markedString = AstNodeToMarkedString(resNode);
		if (markedString !== undefined) return {contents: markedString};
	}
	return null;
});

connection.onDefinition((_params: TextDocumentPositionParams) => {
	let symbol = TraverseTreeDown(ToAstPosition(_params.position), fileASTs[_params.textDocument.uri]);
	if (symbol.type == 'CallExpression') symbol = symbol.base;
	else if (symbol.type == 'FunctionDeclaration') symbol = symbol.identifier;
	if (symbol.type == 'Identifier'){
		let def =  FindIdentifiers(ToAstPosition(_params.position), fileASTs[_params.textDocument.uri])[symbol.name];
		if (def === undefined) return null;
		return ToFileLocation(def, _params.textDocument.uri);
	}
	return null;
});

connection.onDidChangeWatchedFiles((_change) => {
	// Monitored files have change in VSCode
	connection.console.log('We recevied an file change event');
});


// This handler provides the initial list of the completion items.
connection.onCompletion((textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
	// The pass parameter contains the position of the text document in 
	// which code complete got requested. For the example we ignore this
	// info and always provide the same completion items.
	let declarations = FindIdentifiers(ToAstPosition(textDocumentPosition.position), fileASTs[textDocumentPosition.textDocument.uri]);
	let res = [];
	for(let ident in declarations){
		res.push({
			label: ident,
			kind: CompletionItemKind.Variable,
			data: declarations[ident]
		});
	}
	return res;
});

// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	if (item.data === 1) {
		item.detail = 'TypeScript details',
			item.documentation = 'TypeScript documentation'
	} else if (item.data === 2) {
		item.detail = 'JavaScript details',
			item.documentation = 'JavaScript documentation'
	}
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

'use strict';

import {
	IPCMessageReader, IPCMessageWriter, createConnection, IConnection, TextDocuments, TextDocument, 
	Diagnostic, DiagnosticSeverity, InitializeResult, TextDocumentPositionParams, CompletionItem, 
	CompletionItemKind,
	Position,
	Range,
	Location,
} from 'vscode-languageserver';
import { debug } from 'util';
import * as stdLib from './stdLib.json';

let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
let documents: TextDocuments = new TextDocuments();
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

let workspaceRoot: string;
connection.onInitialize((params): InitializeResult => {
	workspaceRoot = params.rootPath;
	debug(workspaceRoot)
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

documents.onDidChangeContent((change) => {
	validateTextDocument(change.document);
});


connection.onDidChangeConfiguration((_) => {
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
	let res : any[] = [];
	for(let ident in declarations){
		let kind : CompletionItemKind;
		if (declarations[ident].type === 'FunctionDeclaration'){
			kind = CompletionItemKind.Function;
		} else {
			kind = CompletionItemKind.Variable;
		}
		res.push({
			label: ident,
			kind: kind,
			data: declarations[ident]
		});
	}
	(<any>stdLib).Variables.forEach((v : string) => {
		res.push({label: v, kind: CompletionItemKind.Variable});
	});
	(<any>stdLib).Functions.forEach((f : string) => {
		res.push({label: f, kind: CompletionItemKind.Function});
	});
	return res;
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

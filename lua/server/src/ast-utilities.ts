import {
	Position,
	Range,
	Location,
} from 'vscode-languageserver';

export interface astPosition {
	line: number,
	column: number
}

export interface astRange {
	start: astPosition
	end: astPosition
}

export interface astNode {
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

export enum identifierType {Number, String, Function, Table, Null, Unknown}

export interface identifierInfo {
	node: astNode
	type: identifierType
}

export function ToAstPosition(pos: Position) {
	return {line : pos.line + 1, column : pos.character}
}

export function ToFileRange(node: astNode): Range {
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

export function ToFileLocation(node: astNode, fileUri: string): Location{
	return {
		uri: fileUri,
		range: ToFileRange(node)
	}
}

export function positionLeq (left: astPosition, right: astPosition): boolean {
	return (left.line < right.line) || ((left.line === right.line) && (left.column <= right.column));
}

export function inRange (elem: astPosition, range: astRange): boolean {
	return positionLeq(range.start, elem) && positionLeq(elem, range.end);
}

export function TraverseTreeDown(p: astPosition, node: astNode): astNode {
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

export function ParseVarName(node:astNode): string{
	switch (node.type){
		case 'Identifier':
			return node.name;
		case 'IndexExpression':
			return ParseVarName(node.base) + '[' + ParseVarName(node.index) + ']';
		case 'MemberExpression':
			return ParseVarName(node.identifier) + '.' + ParseVarName(node.base);
		case 'NumericLiteral':
		case 'StringLiteral':
			return node.value.toString();
	}
	return null;
}

export function FindIdentifiers(p: astPosition, node: astNode): {[id: string]: identifierInfo}{
	function astTypeToSymbolType(type: string) : identifierType {
		switch(type){
			case 'StringLiteral':
				return identifierType.String;
			case 'NumericLiteral':
				return identifierType.Number;
			case 'NilLiteral':
				return identifierType.Null;
			case 'TableConstructor':
				return identifierType.Table;
			default:
				return identifierType.Unknown;
		}
	}
	function FindIdentifiers(p: astPosition, node: astNode, res: {[id: string]: identifierInfo}): {[id: string]: identifierInfo} {
		switch(node.type){
			case 'AssignmentStatement':
			case 'LocalStatement':
				for(let i in node.variables){
					let id = node.variables[i];
					let t = astTypeToSymbolType(node.init[i].type);
					if (t === identifierType.Unknown && node.init[i].name in res) t = res[node.init[i].name].type;
					res[ParseVarName(node)] = {node: id, type: t};
				}
			case 'ForGenericStatement':
				for(let i of node.variables){
					res[i.name] = {node: i, type: identifierType.Unknown };
				}
				break;
			case 'FunctionDeclaration':
				res[node.identifier.name] = {node: node, type: identifierType.Function};
				break;
			case 'ForNumericStatement':
				res[node.variable.name] = {node: node.variable, type: identifierType.Number};
				break;
		}

		if (inRange(p, node.loc) && node.body !== undefined || node.type === 'Chunk'){
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

export function AstNodeToMarkedString(node: astNode) {
	if (node.type === 'chunk') return undefined;
	let type:string = printableType[node.type] || node.type;
	return ['### '+type, '', '---'].join('\n');
}

export function LabelifyFunctionNode(node: astNode, snippet: boolean): string {
	let res: string = node.identifier.name + '(';
	let counter: number = 1;
	for(let arg of node.parameters){
		if(snippet){
			res = res + '${' + counter.toString() + ':' + ParseVarName(arg) + '}';
		} else {
			res = res + ParseVarName(arg);
		}
		if(counter < node.parameters.length){
			res = res + ', ';
		}
		counter++;
	}
	return res + ')';
}
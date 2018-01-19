"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var identifierType;
(function (identifierType) {
    identifierType[identifierType["Number"] = 0] = "Number";
    identifierType[identifierType["String"] = 1] = "String";
    identifierType[identifierType["Function"] = 2] = "Function";
    identifierType[identifierType["Table"] = 3] = "Table";
    identifierType[identifierType["Null"] = 4] = "Null";
    identifierType[identifierType["Unknown"] = 5] = "Unknown";
})(identifierType = exports.identifierType || (exports.identifierType = {}));
//-----------------------------------------------------------------------------
// Funkcje konwertujące między interfejsem luaparse, a vscode-languageserver
//-----------------------------------------------------------------------------
function ToAstPosition(pos) {
    return { line: pos.line + 1, column: pos.character };
}
exports.ToAstPosition = ToAstPosition;
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
exports.ToFileRange = ToFileRange;
function ToFileLocation(node, fileUri) {
    return {
        uri: fileUri,
        range: ToFileRange(node)
    };
}
exports.ToFileLocation = ToFileLocation;
//-----------------------------------------------------------------------------
// Definicja porządku na pozycjach
//-----------------------------------------------------------------------------
function positionLeq(left, right) {
    return (left.line < right.line) || ((left.line === right.line) && (left.column <= right.column));
}
exports.positionLeq = positionLeq;
//-----------------------------------------------------------------------------
// Sprawdzanie czy dana pozycja znajduje się w zadanym przedziale
//-----------------------------------------------------------------------------
function inRange(elem, range) {
    return positionLeq(range.start, elem) && positionLeq(elem, range.end);
}
exports.inRange = inRange;
//-----------------------------------------------------------------------------
// Wizytator TraverseTreeDown
// Dokonuje konwersji pozycja w tekście -> wierzchołek drzewa rozbioru
//-----------------------------------------------------------------------------
// Argumenty:
// p: szukana pozycja w tekście
// node: drzewo do przeszukania
//-----------------------------------------------------------------------------
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
            let expRes = TraverseTreeDown(p, node.expression);
            if (expRes != undefined)
                return expRes;
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
            break;
        case 'IfStatement':
            for (let c of node.clauses) {
                let r = TraverseTreeDown(p, c);
                if (r != undefined)
                    return r;
            }
            break;
        case 'BinaryExpression':
            let leftRes = TraverseTreeDown(p, node.left);
            if (leftRes != undefined)
                return leftRes;
            let rightRes = TraverseTreeDown(p, node.right);
            if (rightRes != undefined)
                return rightRes;
            break;
        case 'UnaryExpression':
            let argRes = TraverseTreeDown(p, node.argument);
            if (argRes != undefined)
                return argRes;
            break;
    }
    return node;
}
exports.TraverseTreeDown = TraverseTreeDown;
//-----------------------------------------------------------------------------
// Funkcja przekładająca drzewo reprezentujące zmienną 
// na napis ją reprezentujący
//-----------------------------------------------------------------------------
// Argumenty:
// node: drzewo do przetłumaczenia
//-----------------------------------------------------------------------------
function ParseVarName(node) {
    switch (node.type) {
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
//-----------------------------------------------------------------------------
// Wizytator przeszukjujący drzewo w poszukiwaniu zmiennych i funkcji
// dostępnych z zadanej w tekście pozycji
//-----------------------------------------------------------------------------
// Argumenty:
// p: pozycja dla której szukamy kontekstu
// node: drzewo do przeszukania
//-----------------------------------------------------------------------------
function FindIdentifiers(p, node) {
    function astTypeToSymbolType(type) {
        switch (type) {
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
    function FindIdentifiers(p, node, res) {
        switch (node.type) {
            case 'AssignmentStatement':
            case 'LocalStatement':
                for (let i in node.variables) {
                    let id = node.variables[i];
                    let t = astTypeToSymbolType(node.init[i].type);
                    if (t === identifierType.Unknown && node.init[i].name in res)
                        t = res[node.init[i].name].type;
                    res[ParseVarName(node)] = { node: id, type: t };
                }
            case 'ForGenericStatement':
                for (let i of node.variables) {
                    res[i.name] = { node: i, type: identifierType.Unknown };
                }
                break;
            case 'FunctionDeclaration':
                res[node.identifier.name] = { node: node, type: identifierType.Function };
                if (inRange(p, node.loc)) {
                    for (let arg of node.parameters) {
                        res[ParseVarName(arg)] = { node: node, type: identifierType.Unknown };
                    }
                }
                break;
            case 'ForNumericStatement':
                res[node.variable.name] = { node: node.variable, type: identifierType.Number };
                break;
        }
        if (inRange(p, node.loc) && node.body !== undefined || node.type === 'Chunk') {
            for (let g of node.body) {
                if (positionLeq(g.loc.start, p))
                    res = FindIdentifiers(p, g, res);
            }
        }
        if (inRange(p, node.loc) && node.clauses !== undefined) {
            for (let g of node.clauses) {
                if (positionLeq(g.loc.start, p))
                    res = FindIdentifiers(p, g, res);
            }
        }
        return res;
    }
    return FindIdentifiers(p, node, {});
}
exports.FindIdentifiers = FindIdentifiers;
//-----------------------------------------------------------------------------
// Funkcja służąca do obsługi zapytania Hover, obliczająca treść wyskakującego okienka
//-----------------------------------------------------------------------------
// Argumenty:
// node: wierzchołek do opisania
//-----------------------------------------------------------------------------
function AstNodeToMarkedString(node) {
    if (HoverTextDictionary[node.type] === undefined) {
        return node.type;
    }
    else {
        return HoverTextDictionary[node.type](node);
    }
}
exports.AstNodeToMarkedString = AstNodeToMarkedString;
let HoverTextDictionary = {
    'LabelStatement': (node) => 'Goto label: ' + node.label,
    'BreakStatement': (_node) => 'Break statement',
    'GotoStatement': (node) => 'Goto statement, label: ' + node.label,
    'ReturnStatement': (node) => 'Return statement, arity: ' + node.arguments.length.toString(),
    'IfStatement': (_node) => 'If statement',
    'IfClause': (_node) => 'If clause',
    'ElseifClause': (_node) => 'Elseif clause',
    'ElseClause': (_node) => 'Else clause',
    'WhileStatement': (_node) => 'While loop',
    'DoStatement': (_node) => 'Do statement',
    'RepeatStatement': (_node) => 'Repeat statement',
    'LocalStatement': (node) => 'Local assignment statement, arity: ' + node.variables.length.toString(),
    'AssignmentStatement': (node) => 'Assignment statement, arity: ' + node.variables.length.toString(),
    'CallStatement': (_node) => 'Function call',
    'FunctionDeclaration': (node) => 'Function ' + LabelifyFunctionNode(node, false),
    'ForNumericStatement': (node) => 'For loop, variable: ' + node.variable.name,
    'ForGenericStatement': (node) => 'Generic for loop, variables: ' + node.variables.map((n) => n.name).join(', '),
    'Chunk': (_node) => undefined,
    'Identifier': (node) => 'Variable ' + ParseVarName(node)
};
//-----------------------------------------------------------------------------
// Funkcja przekładająca drzewo reprezentujące deklarację funkcji
// na napis ją reprezentujący
//-----------------------------------------------------------------------------
// Argumenty:
// node: drzewo do przetłumaczenia
// snippet: Jeśli nastawiony na true, argumenty będą zapisane w notacji
//	 pozwalającej na przeskok między nimi za pomocą klawisza tab
// ref: https://code.visualstudio.com/docs/editor/userdefinedsnippets#_snippet-syntax
//-----------------------------------------------------------------------------
function LabelifyFunctionNode(node, snippet) {
    if (snippet) {
        return node.identifier.name + '(' + node.parameters.map((n, i) => '${' + (i + 1).toString() + ':' + ParseVarName(n) + '}').join(', ') + ')';
    }
    else {
        return node.identifier.name + '(' + node.parameters.map((n) => ParseVarName(n)).join(', ') + ')';
    }
}
exports.LabelifyFunctionNode = LabelifyFunctionNode;
//# sourceMappingURL=ast-utilities.js.map
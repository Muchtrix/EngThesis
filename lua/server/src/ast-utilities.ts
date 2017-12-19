type astPosition = {
	line: number,
	column: number
}

type astRange = {
	start: astPosition
	end: astPosition
}

type astNode = {
	type: string
	loc: astRange
	body?: astNode[]
	name?: string
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
	return node;
}
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
    return node;
}
//# sourceMappingURL=ast-utilities.js.map
const fs = require('fs');
const graph = JSON.parse(fs.readFileSync('ynodesktop/map_graph.json', 'utf8'));

function bfs(start, end) {
    let queue = [start];
    let cameFrom = { [start]: null };
    while (queue.length > 0) {
        let current = queue.shift();
        if (current === end) {
            let path = [];
            let curr = end;
            while (curr !== null) {
                path.push(curr);
                curr = cameFrom[curr];
            }
            return path.reverse();
        }
        let edges = graph[current] || [];
        for (let edge of edges) {
            let neighbor = edge.targetMapId;
            if (!(neighbor in cameFrom)) {
                cameFrom[neighbor] = current;
                queue.push(neighbor);
            }
        }
    }
    return null;
}
const path = bfs(2, 210);
console.log(path);

from collections import deque

def bidirectional_bfs_with_tracks(graph, start_id, end_id):
    if start_id == end_id:
        return [(end_id, None)]

    visited_from_start = {start_id: (None, None)}
    visited_from_end = {end_id: (None, None)}

    queue_start = deque([start_id])
    queue_end = deque([end_id])

    while queue_start and queue_end:
        if len(queue_start) <= len(queue_end):
            meet = expand_frontier(graph, queue_start, visited_from_start, visited_from_end)
        else:
            meet = expand_frontier(graph, queue_end, visited_from_end, visited_from_start)

        if meet is not None:
            return reconstruct_path(meet, visited_from_start, visited_from_end)

    return None

def expand_frontier(graph, queue, visited_this_side, visited_other_side):
    for _ in range(len(queue)):
        current = queue.popleft()
        neighbors = graph.get(current, [])
        for neighbor, track in neighbors:
            if neighbor not in visited_this_side:
                visited_this_side[neighbor] = (current, track)
                if neighbor in visited_other_side:
                    return neighbor
                queue.append(neighbor)
    return None

def reconstruct_path(meeting_node, visited_from_start, visited_from_end):
    path_start = []
    node = meeting_node
    while node is not None:
        parent, track = visited_from_start[node]
        if parent is not None:
            path_start.append((node, track))
        node = parent
    path_start.reverse()

    path_end = []
    node = meeting_node
    while node is not None:
        parent, track = visited_from_end[node]
        if parent is not None:
            path_end.append((parent, track))
        node = parent

    return path_start + path_end

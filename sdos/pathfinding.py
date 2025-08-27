# sdos/pathfinding.py
# Bidirectional BFS with optional excluded edges support

from collections import deque
from typing import Optional, Set, Iterable, Tuple

def bidirectional_bfs_with_tracks(graph, start_id, end_id, excluded_edges: Optional[Iterable[Tuple[int,int]]] = None):
    """
    Bidirectional BFS that returns a path as a list of (artist_id, track)
    The graph is expected to be: dict[artist_id] -> list[(neighbor_id, track_name)]
    excluded_edges: iterable of (a,b) pairs (unordered) that should be ignored when traversing.
    """
    if start_id == end_id:
        return [(end_id, None)]

    # Normalize excluded edges into a set of frozenset pairs for O(1) checks
    excluded_set = set()
    if excluded_edges:
        for e in excluded_edges:
            try:
                a, b = int(e[0]), int(e[1])
                excluded_set.add(frozenset((a, b)))
            except Exception:
                continue

    visited_from_start = {start_id: (None, None)}
    visited_from_end = {end_id: (None, None)}

    queue_start = deque([start_id])
    queue_end = deque([end_id])

    while queue_start and queue_end:
        # expand the smaller frontier
        if len(queue_start) <= len(queue_end):
            meet = _expand_frontier(graph, queue_start, visited_from_start, visited_from_end, excluded_set)
        else:
            meet = _expand_frontier(graph, queue_end, visited_from_end, visited_from_start, excluded_set)

        if meet is not None:
            return _reconstruct_path(meet, visited_from_start, visited_from_end)

    return None

def _expand_frontier(graph, queue, visited_this_side, visited_other_side, excluded_set: Set[frozenset]):
    """
    Expand nodes in 'queue' one level. Skip edges present in excluded_set (frozenset pairs).
    Return meeting node id if found, else None.
    """
    for _ in range(len(queue)):
        current = queue.popleft()
        neighbors = graph.get(current, [])
        for neighbor, track in neighbors:
            # skip excluded edge (unordered)
            if frozenset((current, neighbor)) in excluded_set:
                continue
            if neighbor not in visited_this_side:
                visited_this_side[neighbor] = (current, track)
                if neighbor in visited_other_side:
                    return neighbor
                queue.append(neighbor)
    return None

def _reconstruct_path(meeting_node, visited_from_start, visited_from_end):
    """
    Reconstruct path from start to end given visited dictionaries:
    visited[id] = (parent_id, track_used_to_get_here_from_parent)
    Returns list of (artist_id, track) where track is the track connecting previous artist -> this artist.
    """
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

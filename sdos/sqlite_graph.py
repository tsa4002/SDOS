
import sqlite3
import threading


class SQLiteGraph:
    """Disk-backed graph with the interface used by SDOS pathfinding."""

    def __init__(self, db_path):
        self.db_path = db_path
        self._local = threading.local()

    def _connection(self):
        # Each thread gets its own read-only SQLite connection.
        conn = getattr(self._local, "connection", None)

        if conn is None:
            conn = sqlite3.connect(
                f"file:{self.db_path}?mode=ro",
                uri=True,
                timeout=30,
            )
            self._local.connection = conn

        return conn

    def __contains__(self, artist_id):
        row = self._connection().execute(
            """
            SELECT 1
            FROM edges
            WHERE source_id = ?
            LIMIT 1
            """,
            (int(artist_id),),
        ).fetchone()

        return row is not None

    def __len__(self):
        row = self._connection().execute(
            """
            SELECT COUNT(DISTINCT source_id)
            FROM edges
            """
        ).fetchone()

        return row[0]

    def get(self, artist_id, default=None):
        rows = self._connection().execute(
            """
            SELECT target_id, track_name
            FROM edges
            WHERE source_id = ?
            ORDER BY target_id
            """,
            (int(artist_id),),
        ).fetchall()

        if not rows:
            return default if default is not None else []

        return [(target_id, track_name) for target_id, track_name in rows]

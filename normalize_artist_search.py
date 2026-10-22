
import os
import sqlite3
import unicodedata

DB_PATH = os.path.join(
    "data", "processed", "artist_search.sqlite"
)


def normalize_artist_name(name: str) -> str:
    normalized = unicodedata.normalize("NFKD", name)
    return "".join(
        char
        for char in normalized
        if not unicodedata.combining(char)
    ).casefold()


def main():
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(
            f"Search database not found: {DB_PATH}. "
            "Run this script from your project root."
        )

    conn = sqlite3.connect(DB_PATH)

    try:
        columns = {
            row[1]
            for row in conn.execute(
                "PRAGMA table_info(artists)"
            ).fetchall()
        }

        if "name_normalized" not in columns:
            conn.execute(
                "ALTER TABLE artists "
                "ADD COLUMN name_normalized TEXT"
            )
            print("Added name_normalized column.")
        else:
            print("name_normalized column already exists.")

        cursor = conn.execute(
            "SELECT id, name FROM artists"
        )
        update_cursor = conn.cursor()

        updated = 0

        while True:
            batch = cursor.fetchmany(5000)
            if not batch:
                break

            update_cursor.executemany(
                """
                UPDATE artists
                SET name_normalized = ?
                WHERE id = ?
                """,
                [
                    (normalize_artist_name(name or ""), artist_id)
                    for artist_id, name in batch
                ],
            )

            updated += len(batch)

            if updated % 50000 == 0:
                print(f"Processed {updated:,} artists...")

        conn.commit()
        print(f"Finished. Processed {updated:,} artists.")

    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()

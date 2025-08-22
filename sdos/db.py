import psycopg2

DB_CONFIG = {
    'dbname': 'mb_sdos_db',
    'user': 'tsabera',
    'password': '',
    'host': 'localhost',
    'port': 5432,
}

def get_connection():
    """Return a new PostgreSQL connection."""
    return psycopg2.connect(**DB_CONFIG)

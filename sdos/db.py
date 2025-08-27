import os
import psycopg2
from urllib.parse import urlparse

def get_connection():
    """Return a new PostgreSQL connection."""
    # Check if we're running on Railway (production)
    database_url = os.environ.get('DATABASE_URL')
    
    if database_url:
        # Parse the DATABASE_URL for Railway deployment
        url = urlparse(database_url)
        return psycopg2.connect(
            dbname=url.path[1:],  # Remove leading slash
            user=url.username,
            password=url.password,
            host=url.hostname,
            port=url.port,
        )
    else:
        # Fallback to local development configuration
        DB_CONFIG = {
            'dbname': 'mb_sdos_db',
            'user': 'tsabera',
            'password': '',
            'host': 'localhost',
            'port': 5432,
        }
        return psycopg2.connect(**DB_CONFIG)
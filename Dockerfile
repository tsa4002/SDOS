
FROM python:3.9-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    libpq-dev \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Download the databases required by SDOS
RUN mkdir -p data/processed \
    && curl -fL \
       "https://github.com/tsa4002/SDOS/releases/download/sdos-data-v1/artist_search.sqlite.gz" \
       -o /tmp/artist_search.sqlite.gz \
    && python -c "import gzip, shutil; src = gzip.open('/tmp/artist_search.sqlite.gz', 'rb'); dst = open('data/processed/artist_search.sqlite', 'wb'); shutil.copyfileobj(src, dst); src.close(); dst.close()" \
    && rm /tmp/artist_search.sqlite.gz \
    && curl -fL \
       "https://github.com/tsa4002/SDOS/releases/download/sdos-data-v1/collaboration_graph.sqlite" \
       -o data/processed/collaboration_graph.sqlite \
    && python normalize_artist_search.py

# Start the application
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]

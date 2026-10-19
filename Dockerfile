FROM python:3.12-slim
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG VERSION=0.6.0
ARG SOURCE_URL
LABEL org.opencontainers.image.title="StarIsle" \
      org.opencontainers.image.description="Self-hosted Chinese sky chart, Moon calendar and Solar System" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.source=$SOURCE_URL \
      org.opencontainers.image.licenses="MIT AND CC-BY-SA-4.0"
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" -r requirements.txt
COPY app.py earth_satellites.py ./
COPY static ./static
COPY scripts ./scripts
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md CATALOG_LICENSES.md data-manifest.json ./
COPY LICENSES ./LICENSES
RUN cp static/app.js static/app.v0.61.js && cp static/styles.css static/styles.v0.46.css
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD python -c "import json,urllib.request; d=json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=4)); raise SystemExit(d['status']!='ready')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]

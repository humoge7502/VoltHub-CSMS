# VoltHub AI advisory sidecar (ADR-0008).
# CPU-only image: the sidecar serves forecasts; training stays on the GPU host.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY apps/ai/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir \
      --extra-index-url https://download.pytorch.org/whl/cpu \
      -r /app/requirements.txt

COPY apps/ai/ /app/

EXPOSE 8100

# /health is token-gated, so the probe sends the same x-internal header the API uses.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import os,urllib.request as u; r=u.Request('http://127.0.0.1:8100/health', headers={'x-internal': os.environ.get('AI_TOKEN','dev-internal')}); u.urlopen(r, timeout=3); print('ok')" || exit 1

CMD ["python", "service.py"]

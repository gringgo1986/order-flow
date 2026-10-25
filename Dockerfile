FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Auto-reorganize files if uploaded flat to root on GitHub
RUN mkdir -p /app/static/js /app/static/css && \
    (test -f /app/index.html && cp -f /app/index.html /app/static/index.html || true) && \
    (test -f /app/style.css && cp -f /app/style.css /app/static/css/style.css || true) && \
    (test -f /app/bookmap.js && cp -f /app/bookmap.js /app/static/js/bookmap.js || true) && \
    (test -f /app/footprint.js && cp -f /app/footprint.js /app/static/js/footprint.js || true) && \
    (test -f /app/dom.js && cp -f /app/dom.js /app/static/js/dom.js || true) && \
    (test -f /app/app.js && cp -f /app/app.js /app/static/js/app.js || true)

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
